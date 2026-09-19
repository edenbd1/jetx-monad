// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {JetUSD} from "./JetUSD.sol";

/// @title JetX
/// @notice Single-player rocket crash game. Every flight is two transactions from the player:
///         `launch` (bet burned, crash point drawn) and either `cashOut` at the multiplier the
///         player stopped at, or `settle` once the rocket blew up.
/// @dev Multipliers are fixed-point x100 (250 = 2.50x). The crash point follows the classic
///      crash-game curve P(base >= x) = rtp / x, stretched above 1x by `boost` for a more
///      generous testnet game (defaults: 1.5% instant busts, median ~2.45x), capped at `maxMultiplier`.
///      Randomness comes from block data at launch: fine for a testnet game with test dollars,
///      a production version would use a VRF or a commit-reveal house seed.
contract JetX is Ownable {
    uint256 public constant MIN_BET = 0.1e6;
    uint256 public constant MAX_BET = 1_000e6;
    uint256 public constant FAUCET_AMOUNT = 1_000e6;
    uint256 public constant FAUCET_THRESHOLD = 100e6;
    /// @notice Hard bounds for the house-set cap on crash points (2x .. 1000x).
    uint32 public constant MIN_CAP = 200;
    uint32 public constant MAX_CAP = 100_000;
    /// @notice Bounds for the house-tuned curve (see `setCurve`).
    uint16 public constant MIN_RTP_BPS = 9_000;
    uint16 public constant MAX_RTP_BPS = 10_000;
    uint16 public constant MIN_BOOST_BPS = 10_000;
    uint16 public constant MAX_BOOST_BPS = 30_000;
    uint256 public constant ABANDON_AFTER = 1 hours;
    uint256 public constant HISTORY = 20;

    enum Status {
        None,
        Flying,
        CashedOut,
        Crashed
    }

    struct Round {
        address player;
        uint96 bet;
        uint64 startedAt;
        uint32 crash;
        uint32 cashedAt;
        Status status;
    }

    JetUSD public immutable usd;

    uint256 public roundCount;
    mapping(uint256 => Round) internal _rounds;
    mapping(address => uint256) public activeRound;

    uint32[HISTORY] internal _recent;
    uint256 internal _recentCount;

    /// @notice Crash points are capped here (x100). Starts at 50x.
    uint32 public maxMultiplier = 5_000;
    /// @notice Base curve P(crash >= x) = rtp / x; below 1.00x is an instant bust (1 - rtp of flights).
    uint16 public rtpBps = 9_850;
    /// @notice Stretches every flight above 1x: crash = 1 + (base - 1) * boost. 15000 = 1.5x.
    uint16 public boostBps = 15_000;

    uint256 public totalWagered;
    uint256 public totalPaid;
    uint32 public bestCashOut;
    address public bestCashOutBy;

    event Launched(uint256 indexed id, address indexed player, uint256 bet);
    event CashedOut(uint256 indexed id, address indexed player, uint32 multiplier, uint256 payout, uint32 crash);
    event Crashed(uint256 indexed id, address indexed player, uint256 bet, uint32 crash);
    event Faucet(address indexed player, uint256 amount);
    event MaxMultiplierSet(uint32 maxMultiplier);
    event CurveSet(uint16 rtpBps, uint16 boostBps);

    error BadBet();
    error NotYourRound();
    error NotFlying();
    error BadMultiplier();
    error AboveCrash();
    error StillFlying();
    error NotBroke();
    error BadCap();
    error BadCurve();

    constructor(address owner_) Ownable(owner_) {
        usd = new JetUSD(address(this));
    }

    // ---------------------------------------------------------------- player

    /// @notice Tx 1: burns the bet and draws this flight's crash point. Any flight the player
    ///         left unfinished is forfeited first.
    function launch(uint256 bet) external returns (uint256 id) {
        if (bet < MIN_BET || bet > MAX_BET) revert BadBet();
        uint256 previous = activeRound[msg.sender];
        if (previous != 0) _crash(previous);

        usd.burn(msg.sender, bet);
        id = ++roundCount;
        uint32 crash = _drawCrash(id);
        _rounds[id] = Round(msg.sender, uint96(bet), uint64(block.timestamp), crash, 0, Status.Flying);
        activeRound[msg.sender] = id;
        totalWagered += bet;
        emit Launched(id, msg.sender, bet);
    }

    /// @notice Tx 2 (win): cashes out at `multiplier` (x100), which must not exceed the crash point.
    function cashOut(uint256 id, uint32 multiplier) external returns (uint256 payout) {
        Round storage r = _rounds[id];
        if (r.player != msg.sender) revert NotYourRound();
        if (r.status != Status.Flying) revert NotFlying();
        if (multiplier < 100) revert BadMultiplier();
        if (multiplier > r.crash) revert AboveCrash();

        payout = uint256(r.bet) * multiplier / 100;
        r.status = Status.CashedOut;
        r.cashedAt = multiplier;
        delete activeRound[msg.sender];
        _record(r.crash);
        totalPaid += payout;
        if (multiplier > bestCashOut) {
            bestCashOut = multiplier;
            bestCashOutBy = msg.sender;
        }
        usd.mint(msg.sender, payout);
        emit CashedOut(id, msg.sender, multiplier, payout, r.crash);
    }

    /// @notice Tx 2 (loss): closes a flight that blew up. Anyone can close an abandoned flight.
    function settle(uint256 id) external {
        Round storage r = _rounds[id];
        if (r.status != Status.Flying) revert NotFlying();
        if (r.player != msg.sender && block.timestamp < r.startedAt + ABANDON_AFTER) revert StillFlying();
        _crash(id);
    }

    /// @notice 1,000 test USDC when the wallet is (nearly) broke.
    function faucet() external {
        if (usd.balanceOf(msg.sender) >= FAUCET_THRESHOLD) revert NotBroke();
        usd.mint(msg.sender, FAUCET_AMOUNT);
        emit Faucet(msg.sender, FAUCET_AMOUNT);
    }

    // ---------------------------------------------------------------- house

    /// @notice Caps every future crash point (x100), within [MIN_CAP, MAX_CAP].
    function setMaxMultiplier(uint32 cap) external onlyOwner {
        if (cap < MIN_CAP || cap > MAX_CAP) revert BadCap();
        maxMultiplier = cap;
        emit MaxMultiplierSet(cap);
    }

    /// @notice Tunes how generous flights are, within fixed bounds.
    function setCurve(uint16 rtp, uint16 boost) external onlyOwner {
        if (rtp < MIN_RTP_BPS || rtp > MAX_RTP_BPS || boost < MIN_BOOST_BPS || boost > MAX_BOOST_BPS) revert BadCurve();
        rtpBps = rtp;
        boostBps = boost;
        emit CurveSet(rtp, boost);
    }

    /// @notice Lets the house top up players it onboards (managed wallets).
    function grant(address to, uint256 amount) external onlyOwner {
        usd.mint(to, amount);
        emit Faucet(to, amount);
    }

    // ---------------------------------------------------------------- views

    function getRound(uint256 id) external view returns (Round memory) {
        return _rounds[id];
    }

    /// @notice Last crash points, newest first.
    function recentCrashes() external view returns (uint32[] memory out) {
        uint256 n = _recentCount < HISTORY ? _recentCount : HISTORY;
        out = new uint32[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = _recent[(_recentCount - 1 - i) % HISTORY];
        }
    }

    // ---------------------------------------------------------------- internal

    function _crash(uint256 id) internal {
        Round storage r = _rounds[id];
        r.status = Status.Crashed;
        delete activeRound[r.player];
        _record(r.crash);
        emit Crashed(id, r.player, r.bet, r.crash);
    }

    function _record(uint32 crash) internal {
        _recent[_recentCount % HISTORY] = crash;
        ++_recentCount;
    }

    /// @dev Base draw P(base >= x) = rtp / x (below 1.00x: instant bust), then the part above 1x is
    ///      stretched by `boost`: P(crash >= x) = rtp / (1 + (x - 1) / boost). Capped at `maxMultiplier`.
    function _drawCrash(uint256 id) internal view returns (uint32) {
        uint256 r = uint256(
            keccak256(abi.encode(block.prevrandao, blockhash(block.number - 1), block.timestamp, msg.sender, id))
        ) % 1e6;
        uint256 base = uint256(rtpBps) * 1e6 / (1e6 - r); // x10000, finer than the x100 result
        if (base <= 10_000) return 100; // instant bust
        // Round the boosted part up so only real busts land on 1.00x.
        uint256 crash = 100 + ((base - 10_000) * boostBps / 10_000 + 99) / 100;
        if (crash > maxMultiplier) crash = maxMultiplier;
        return uint32(crash);
    }
}
