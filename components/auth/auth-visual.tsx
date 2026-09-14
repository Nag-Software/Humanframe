"use client";

import Image from "next/image";
import { motion, useReducedMotion } from "motion/react";

import { useTranslations } from "@/components/i18n-provider";

const MARK_SIZE = 112;

/** Slow drifting shapes. Large, blurred and almost invisible on purpose. */
const shapes = [
  {
    className:
      "left-[-18%] top-[6%] h-[62%] w-[62%] bg-[#1d2733] [border-radius:52%_48%_43%_57%/46%_52%_48%_54%]",
    animate: { x: [0, 42, -18, 0], y: [0, -26, 22, 0], rotate: [0, 8, -4, 0] },
    duration: 118,
  },
  {
    className:
      "right-[-22%] top-[24%] h-[74%] w-[70%] bg-[#2a2420] [border-radius:46%_54%_55%_45%/52%_44%_56%_48%]",
    animate: { x: [0, -34, 16, 0], y: [0, 28, -20, 0], rotate: [0, -6, 5, 0] },
    duration: 142,
  },
  {
    className:
      "bottom-[-24%] left-[16%] h-[58%] w-[66%] bg-[#191f28] [border-radius:55%_45%_48%_52%/44%_56%_44%_56%]",
    animate: { x: [0, 26, -30, 0], y: [0, -18, 14, 0], rotate: [0, 5, -7, 0] },
    duration: 96,
  },
];

export default function AuthVisual() {
  const reduceMotion = useReducedMotion();

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#08080a]">
      {/* Organic background forms */}
      <div className="absolute inset-0 opacity-[0.55]">
        {shapes.map((shape, index) => (
          <motion.div
            key={index}
            className={`absolute blur-[90px] ${shape.className}`}
            animate={reduceMotion ? undefined : shape.animate}
            transition={{
              duration: shape.duration,
              repeat: Infinity,
              repeatType: "mirror",
              ease: "easeInOut",
            }}
          />
        ))}
      </div>

      {/* Depth: a soft vignette pulls the eye to the centre */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(70% 55% at 50% 45%, rgba(255,255,255,0.05), rgba(0,0,0,0) 60%), radial-gradient(120% 90% at 50% 50%, rgba(0,0,0,0) 35%, rgba(0,0,0,0.65) 100%)",
        }}
      />

      <div className="relative flex h-full w-full flex-col items-center justify-center gap-10">
        <motion.div
          className="relative"
          style={{ width: MARK_SIZE, height: MARK_SIZE }}
          animate={reduceMotion ? undefined : { scale: [1, 1.022, 1] }}
          transition={{
            duration: 18,
            repeat: Infinity,
            repeatType: "mirror",
            ease: "easeInOut",
          }}
        >
          {/* Halo behind the mark */}
          <div
            aria-hidden
            className="absolute -inset-10 rounded-full bg-white/[0.06] blur-3xl"
          />

          {/* The mark itself, inverted so it reads light on near-black */}
          <Image
            src="/icon.png"
            alt="Humanframe"
            width={MARK_SIZE}
            height={MARK_SIZE}
            priority
            className="relative size-full opacity-90 invert"
          />

          {/* Light moving across the mark, masked to its silhouette */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden"
            style={{
              WebkitMaskImage: "url(/icon.png)",
              maskImage: "url(/icon.png)",
              WebkitMaskSize: "contain",
              maskSize: "contain",
              WebkitMaskRepeat: "no-repeat",
              maskRepeat: "no-repeat",
              WebkitMaskPosition: "center",
              maskPosition: "center",
            }}
          >
            <motion.div
              className="absolute inset-y-[-40%] w-[70%]"
              style={{
                background:
                  "linear-gradient(105deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.28) 50%, rgba(255,255,255,0) 100%)",
                filter: "blur(6px)",
              }}
              initial={{ x: "-120%" }}
              animate={reduceMotion ? undefined : { x: ["-120%", "190%"] }}
              transition={{
                duration: 7,
                repeat: Infinity,
                repeatDelay: 9,
                ease: "easeInOut",
              }}
            />
          </div>
        </motion.div>

        <Tagline />
      </div>
    </div>
  );
}

function Tagline() {
  const t = useTranslations();
  return (
    <p className="text-[13px] font-light tracking-[0.18em] text-white/25 uppercase">
      {t.auth.brandTagline}
    </p>
  );
}
