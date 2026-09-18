"use client";

import { useEffect, useRef, type RefObject } from "react";
import { useReducedMotion } from "motion/react";

import { cn } from "@/lib/utils";

/**
 * Her presence on a call: a sphere of small particles that breathes while
 * she listens and opens when she speaks.
 *
 * It is drawn on a 2D canvas, one point per particle, so it costs nothing to
 * ship and runs on anything. The particles sit on a soft shell around her
 * face, rotate slowly, and are lit by depth — the ones facing you are bright,
 * the ones behind her are faint. Audio energy pushes the shell outward and
 * brightens it; nothing else in the app moves like this, on purpose.
 *
 * With reduced motion the field is drawn once and left still.
 */
export type ParticleMode =
  /** Connecting: the particles drift in from further out and settle. */
  | "ringing"
  /** Connected: breathing, and reacting to her voice. */
  | "live"
  /** Ended or failed: still. */
  | "idle";

type Particle = {
  x: number;
  y: number;
  z: number;
  /** Distance from centre relative to the shell, so the shell has depth. */
  shell: number;
  phase: number;
  speed: number;
};

const COUNT = 760;
const TILT = 0.38;
const ROTATION_PER_SECOND = 0.14;
const RINGING_SETTLE_MS = 2600;

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function seed(count: number): Particle[] {
  // Fibonacci sphere: even coverage without a grid showing through.
  const golden = Math.PI * (3 - Math.sqrt(5));
  const particles: Particle[] = [];
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (i / (count - 1)) * 2;
    const radius = Math.sqrt(1 - y * y);
    const theta = golden * i;
    const jitter = Math.random();
    particles.push({
      x: Math.cos(theta) * radius,
      y,
      z: Math.sin(theta) * radius,
      shell: 0.86 + 0.14 * Math.sqrt(jitter),
      phase: Math.random() * Math.PI * 2,
      speed: 0.5 + Math.random() * 0.9,
    });
  }
  return particles;
}

function parseColor(value: string): [number, number, number] {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) {
    return [240, 238, 232];
  }
  const [r, g, b] = match[1]!.split(/[\s,\/]+/).map(Number);
  return [r ?? 240, g ?? 238, b ?? 232];
}

export function ParticleField({
  size,
  mode,
  energyRef,
  speaking = false,
  hollow = 0,
  className,
}: {
  /** Width and height of the field in CSS pixels. */
  size: number;
  mode: ParticleMode;
  /** 0..1, written every frame by whoever hears her. Read, never rendered. */
  energyRef?: RefObject<number>;
  speaking?: boolean;
  /** Radius, in CSS pixels, kept clear in front — where her face is. */
  hollow?: number;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const particles = useRef<Particle[] | null>(null);
  const reduceMotion = useReducedMotion();
  const modeRef = useRef(mode);
  const speakingRef = useRef(speaking);
  const modeSince = useRef(0);

  useEffect(() => {
    if (modeRef.current !== mode || modeSince.current === 0) {
      modeSince.current = performance.now();
    }
    modeRef.current = mode;
    speakingRef.current = speaking;
  }, [mode, speaking]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) {
      return;
    }
    const context = element.getContext("2d");
    if (!context) {
      return;
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    element.width = size * dpr;
    element.height = size * dpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    particles.current ??= seed(COUNT);
    const points = particles.current;
    const centre = size / 2;
    const base = size * 0.4;
    const [r, g, b] = parseColor(getComputedStyle(element).color);

    let smoothed = 0;
    let frame = 0;
    const started = performance.now();

    const draw = (now: number) => {
      const t = (now - started) / 1000;
      const current = modeRef.current;
      const target = current === "live" ? (energyRef?.current ?? 0) : 0;
      // Attack fast, release slow: the shell opens with her voice and eases
      // back rather than flickering with every syllable.
      smoothed += (target - smoothed) * (target > smoothed ? 0.35 : 0.06);
      const voice = Math.min(1, smoothed * 1.15 + (speakingRef.current ? 0.12 : 0));

      let radius = base * (1 + 0.022 * Math.sin(t * 0.9));
      if (current === "ringing") {
        const settle = easeOutCubic(
          Math.min(1, (now - modeSince.current) / RINGING_SETTLE_MS)
        );
        radius *= 1.42 - 0.42 * settle;
        radius *= 1 + 0.05 * Math.sin(t * 2.4);
      } else if (current === "live") {
        radius *= 1 + voice * 0.26;
      }

      const spin = t * ROTATION_PER_SECOND * (1 + voice * 0.6);
      const cosY = Math.cos(spin);
      const sinY = Math.sin(spin);
      const cosX = Math.cos(TILT);
      const sinX = Math.sin(TILT);

      context.clearRect(0, 0, size, size);

      // A faint glow at the centre, brighter as she speaks.
      const glow = context.createRadialGradient(
        centre,
        centre,
        0,
        centre,
        centre,
        radius * 1.1
      );
      glow.addColorStop(0, `rgba(${r},${g},${b},${0.05 + voice * 0.08})`);
      glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
      context.fillStyle = glow;
      context.fillRect(0, 0, size, size);

      for (const p of points) {
        const wobble =
          1 +
          0.028 * Math.sin(t * p.speed + p.phase) +
          voice * 0.07 * Math.sin(t * 6.5 + p.phase * 3);
        const rx = p.x * cosY - p.z * sinY;
        const rz = p.x * sinY + p.z * cosY;
        const ry = p.y * cosX - rz * sinX;
        const depth = p.y * sinX + rz * cosX; // -1 back … +1 front

        const distance = radius * p.shell * wobble;
        const px = centre + rx * distance;
        const py = centre + ry * distance;

        if (hollow > 0 && depth > 0) {
          const dx = px - centre;
          const dy = py - centre;
          if (dx * dx + dy * dy < hollow * hollow) {
            continue;
          }
        }

        const facing = (depth + 1) / 2;
        const alpha = 0.16 + 0.7 * facing * facing + voice * 0.12 * facing;
        const dot = 0.7 + 1.4 * facing + voice * 0.5 * facing;
        context.fillStyle = `rgba(${r},${g},${b},${Math.min(1, alpha)})`;
        context.fillRect(px - dot / 2, py - dot / 2, dot, dot);
      }
    };

    if (reduceMotion) {
      draw(started);
      return;
    }

    const loop = (now: number) => {
      draw(now);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [size, hollow, energyRef, reduceMotion]);

  return (
    <canvas
      ref={canvas}
      aria-hidden
      className={cn("block", className)}
      style={{ width: size, height: size }}
    />
  );
}
