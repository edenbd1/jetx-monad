// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {JetUSD} from "./JetUSD.sol";

/// @title JetX
/// @notice Single-player rocket crash game. Every flight is two transactions from the player:
///         `launch` (bet burned, crash point drawn) and either `cashOut` at the multiplier the
///         player stopped at, or `settle` once the rocket blew up.
/// @dev Multipliers are fixed-point x100 (250 = 2.50x). The crash point follows the classic
///      crash-game distribution P(crash >= x) = 0.97 / x (3% house edge, 3% instant busts).
///      Randomness comes from block data at launch: fine for a testnet game with test dollars,
///      a production version would use a VRF or a commit-reveal house seed.
contract JetX is Ownable {
    uint256 public constant MIN_BET = 0.1e6;
    uint256 public constant MAX_BET = 1_000e6;
    uint256 public constant FAUCET_AMOUNT = 1_000e6;
    uint256 public constant FAUCET_THRESHOLD = 100e6;
    uint32 public constant MAX_MULTIPLIER = 100_000; // 1000x
    uint256 public constant RTP_BPS = 9_700; // 97% return to player
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

    uint256 public totalWagered;
    uint256 public totalPaid;
    uint32 public bestCashOut;
    address public bestCashOutBy;

    event Launched(uint256 indexed id, address indexed player, uint256 bet);
    event CashedOut(uint256 indexed id, address indexed player, uint32 multiplier, uint256 payout, uint32 crash);
    event Crashed(uint256 indexed id, address indexed player, uint256 bet, uint32 crash);
    event Faucet(address indexed player, uint256 amount);

    error BadBet();
    error NotYourRound();
    error NotFlying();
    error BadMultiplier();
    error AboveCrash();
    error StillFlying();
    error NotBroke();

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

    /// @dev P(crash >= x) = 0.97 / x; results below 1.00x are instant busts at 1.00x.
    function _drawCrash(uint256 id) internal view returns (uint32) {
        uint256 r = uint256(
            keccak256(abi.encode(block.prevrandao, blockhash(block.number - 1), block.timestamp, msg.sender, id))
        ) % 1e6;
        uint256 crash = RTP_BPS * 1e4 / (1e6 - r); // x100
        if (crash < 100) crash = 100;
        if (crash > MAX_MULTIPLIER) crash = MAX_MULTIPLIER;
        return uint32(crash);
    }
}
