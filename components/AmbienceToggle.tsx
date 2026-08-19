"use client";

import { useEffect, useRef, useState } from "react";
import { OceanAmbience, type AmbienceState } from "./audio/oceanAmbience";

/**
 * Speaker toggle for the ambient surf. Sits in the top-right corner, on the
 * same inset as the hero padding so it reads as part of the composition
 * rather than parked on top of it.
 *
 * The page never makes noise on load. This starts muted; sound begins only
 * when someone presses the button, or — if they already turned it on earlier
 * this session — at their next gesture, which is what the browser will
 * actually allow.
 */
export default function AmbienceToggle() {
  const ambienceRef = useRef<OceanAmbience | null>(null);
  const [state, setState] = useState<AmbienceState>({
    muted: true,
    running: false,
  });

  useEffect(() => {
    const ambience = new OceanAmbience({ onStateChange: setState });
    ambienceRef.current = ambience;
    ambience.armAutostart();

    const onVisibility = () => ambience.setPageHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      ambience.dispose();
      ambienceRef.current = null;
    };
  }, []);

  const on = !state.muted;

  return (
    <button
      type="button"
      onClick={() => void ambienceRef.current?.toggle()}
      aria-pressed={on}
      aria-label={on ? "Mute ambient ocean sound" : "Play ambient ocean sound"}
      title={on ? "Mute ambient ocean" : "Play ambient ocean"}
      className="pointer-events-auto fixed right-[clamp(1.6rem,5vw,4rem)] top-[clamp(1.6rem,5vw,4rem)] z-[6] flex h-11 w-11 items-center justify-center rounded-full border border-[rgba(234,247,255,0.22)] bg-[rgba(6,36,58,0.38)] text-foam shadow-[0_2px_20px_rgba(0,10,22,0.45)] backdrop-blur-md transition-colors duration-300 hover:border-[rgba(234,247,255,0.45)] hover:bg-[rgba(6,36,58,0.6)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(79,204,245,0.75)] focus-visible:ring-offset-0"
    >
      <svg
        width="21"
        height="21"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="drop-shadow-[0_1px_6px_rgba(0,10,22,.7)]"
      >
        {/* cone */}
        <path d="M4 9.2h3.1L11.4 5.6v12.8L7.1 14.8H4z" />
        {on ? (
          <>
            <path d="M14.6 9.4a3.9 3.9 0 0 1 0 5.2" opacity="0.95" />
            <path className="ambience-wave" d="M17.4 6.9a7.6 7.6 0 0 1 0 10.2" />
          </>
        ) : (
          <>
            <path d="M15.2 9.6l4.6 4.8" opacity="0.85" />
            <path d="M19.8 9.6l-4.6 4.8" opacity="0.85" />
          </>
        )}
      </svg>
      <span className="sr-only">
        {on ? "Ambient ocean sound is on" : "Ambient ocean sound is off"}
      </span>
    </button>
  );
}
