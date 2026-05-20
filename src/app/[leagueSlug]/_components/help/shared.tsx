"use client";

import type { ReactNode } from "react";
import Link from "next/link";

export type UserRole = "public" | "team" | "admin";
export type ActiveTab = "faqs" | "scenarios";

export interface FaqEntry {
  question: string;
  answer: ReactNode;
}

export interface ScenarioEntry {
  number: number;
  title: string;
  steps: string[];
}

export function AccordionItem({
  index,
  question,
  answer,
  openIndex,
  setOpenIndex,
}: {
  index: number;
  question: string;
  answer: ReactNode;
  openIndex: number | null;
  setOpenIndex: (i: number | null) => void;
}) {
  const isOpen = openIndex === index;
  return (
    <div className="border border-white/10 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpenIndex(isOpen ? null : index)}
        className="w-full flex items-center justify-between px-5 py-4 text-left text-white font-medium hover:bg-white/5 transition"
      >
        <span>{question}</span>
        <span className="ml-4 text-gray-400 shrink-0 text-xs">{isOpen ? "▲" : "▼"}</span>
      </button>
      {isOpen && (
        <div className="px-5 pb-5 text-gray-300 text-sm leading-relaxed border-t border-white/10 pt-4">
          {answer}
        </div>
      )}
    </div>
  );
}

export function ScenarioCard({ number, title, steps }: ScenarioEntry) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
      <h3 className="font-semibold text-white mb-3">
        <span className="text-yellow-400 mr-2">{number}.</span>
        {title}
      </h3>
      <ol className="list-decimal list-inside space-y-2 text-gray-300 text-sm">
        {steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
    </div>
  );
}

export function PublicSignInPrompt({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
      <p className="text-gray-400 text-sm">
        <strong className="text-white">Team member?</strong> {message}
      </p>
      <Link
        href="/signin"
        className="inline-block mt-3 rounded-full bg-gradient-to-r from-yellow-400 to-orange-500 px-6 py-2 font-semibold text-slate-900 text-sm hover:from-yellow-300 hover:to-orange-400 transition"
      >
        Sign In
      </Link>
    </div>
  );
}

export function HelpTabBar({
  activeTab,
  onChange,
}: {
  activeTab: ActiveTab;
  onChange: (t: ActiveTab) => void;
}) {
  return (
    <div className="flex gap-2 mb-8">
      {(["faqs", "scenarios"] as const).map((tab) => (
        <button
          key={tab}
          onClick={() => onChange(tab)}
          className={`px-5 py-2.5 rounded-lg font-semibold text-sm transition ${
            activeTab === tab ? "bg-yellow-500 text-slate-900" : "bg-white/5 text-gray-300 hover:bg-white/10"
          }`}
        >
          {tab === "faqs" ? "FAQs" : "Scenarios"}
        </button>
      ))}
    </div>
  );
}

export function SectionDivider({ title, color }: { title: string; color: "yellow" | "purple" | "orange" }) {
  const text = color === "yellow" ? "text-yellow-400" : color === "orange" ? "text-orange-400" : "text-purple-400";
  const line = color === "yellow" ? "bg-yellow-400/20" : color === "orange" ? "bg-orange-400/20" : "bg-purple-400/20";
  return (
    <h2 className={`text-lg font-bold ${text} mb-3 flex items-center gap-2`}>
      <span className={`h-px flex-1 ${line}`} />
      {title}
      <span className={`h-px flex-1 ${line}`} />
    </h2>
  );
}
