"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { CLIPS, type Clip, type ClipPlayer, type Mode } from "@/lib/kaaris";

export type KaarisCamHandle = ClipPlayer & { setMuted(muted: boolean): void };

/**
 * Floating "facecam" bubble. One <video> element does all the playback: it gets unlocked by the
 * splash tap (iOS only lets a media element play sound after a user gesture), then every clip is
 * swapped in from an in-memory blob so reactions start instantly.
 */
export const KaarisCam = forwardRef<KaarisCamHandle, { muted: boolean; onMode?: (mode: Mode | null) => void }>(function KaarisCam(
  { muted, onMode },
  ref,
) {
  const video = useRef<HTMLVideoElement>(null);
  const blobs = useRef(new Map<string, string>());
  const done = useRef<(() => void) | null>(null);
  const mutedRef = useRef(muted);
  const [showing, setShowing] = useState<{ clip: Clip; mode: Mode; key: number } | null>(null);

  // Preload every clip into memory.
  useEffect(() => {
    let cancelled = false;
    const urls = blobs.current;
    for (const clip of CLIPS) {
      fetch(clip.src)
        .then((r) => r.blob())
        .then((b) => {
          if (!cancelled) urls.set(clip.id, URL.createObjectURL(b));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
      urls.clear();
    };
  }, []);

  useEffect(() => {
    mutedRef.current = muted;
    if (video.current) video.current.muted = muted;
  }, [muted]);

  useImperativeHandle(
    ref,
    () => ({
      play(clip, mode) {
        const v = video.current;
        done.current?.();
        return new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(guard);
            v?.removeEventListener("ended", finish);
            if (done.current === finish) {
              done.current = null;
              setShowing((s) => (s?.clip.id === clip.id ? null : s));
            }
            resolve();
          };
          // Safety net if "ended" never fires (decode error, tab hidden…).
          const guard = setTimeout(finish, (clip.duration + 1.5) * 1000);
          done.current = finish;
          setShowing({ clip, mode, key: Date.now() });
          if (!v) return finish();
          v.src = blobs.current.get(clip.id) ?? clip.src;
          v.muted = mutedRef.current;
          v.currentTime = 0;
          v.addEventListener("ended", finish);
          // play() must be called synchronously inside the tap that unlocked audio.
          v.play().catch(() => {
            // Autoplay with sound refused: retry muted so the reaction still shows.
            v.muted = true;
            v.play().catch(finish);
          });
        });
      },
      stop() {
        video.current?.pause();
        done.current?.();
      },
      setMuted(m) {
        mutedRef.current = m;
        if (video.current) video.current.muted = m;
      },
    }),
    [],
  );

  useEffect(() => {
    onMode?.(showing?.mode ?? null);
  }, [showing, onMode]);

  const mode = showing?.mode ?? "normal";
  return (
    <div className={`cam cam-${mode}`} data-on={showing ? "" : undefined} aria-hidden={!showing}>
      {mode === "moon" && showing && <div className="cam-banner">🚀 THOMAS PESQUET</div>}
      <div className="cam-frame">
        <video ref={video} className="cam-video" playsInline preload="auto" muted={muted} poster="/kaaris/poster.jpg" />
        <span className="cam-live">
          <i /> KAARIS
        </span>
      </div>
      {showing && (
        <div key={showing.key} className="cam-caption">
          {showing.clip.caption}
        </div>
      )}
    </div>
  );
});
