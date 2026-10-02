"use client";

import { Sheet } from "@/components/ui/Sheet";

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12M8 7l4-4 4 4" />
      <path d="M6 11H5a1 1 0 00-1 1v8a1 1 0 001 1h14a1 1 0 001-1v-8a1 1 0 00-1-1h-1" />
    </svg>
  );
}

function AddBoxIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

/**
 * iOS has no install prompt — Safari only offers "Add to Home Screen" from its Share menu, and
 * nothing a page does can open that menu. So on iPhone/iPad "Install app" opens these steps.
 */
export function InstallSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const steps = [
    {
      icon: <ShareIcon />,
      text: (
        <>
          Tap <strong className="text-white">Share</strong> in the browser toolbar (the square with an arrow).
        </>
      ),
    },
    {
      icon: <AddBoxIcon />,
      text: (
        <>
          Scroll down and tap <strong className="text-white">Add to Home Screen</strong>.
        </>
      ),
    },
    {
      icon: <span className="text-base font-bold">✓</span>,
      text: (
        <>
          Tap <strong className="text-white">Add</strong>. JPL opens full-screen from your home screen, like any other app.
        </>
      ),
    },
  ];

  return (
    <Sheet open={open} onClose={onClose} title="Install JPL on your iPhone" description="Three taps, no App Store needed." size="md">
      <ol className="space-y-3">
        {steps.map((step, i) => (
          <li key={i} className="flex items-start gap-3 rounded-2xl bg-white/5 p-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sky-500/20 text-sky-300">
              {step.icon}
            </span>
            <span className="pt-1.5 text-sm leading-relaxed text-gray-300">{step.text}</span>
          </li>
        ))}
      </ol>
    </Sheet>
  );
}
