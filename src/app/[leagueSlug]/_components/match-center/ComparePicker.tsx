"use client";

import { GwNavigator } from "@/components/GwNavigator";
import type { MatchCenterTeamOption } from "@/lib/match-center/load";

/**
 * Pick any two teams and any started gameweek.
 *
 * Opens on the fixture the reader clicked, but nothing here is tied to it — a team can be lined
 * up against anyone in the league, across groups, which is the whole point of the picker.
 * Ghost teams have no squad to compare and are left out unless already on screen.
 */
export function ComparePicker({
  teams,
  a,
  b,
  gws,
  gw,
  onChange,
  accent = "default",
  disabled,
}: {
  teams: MatchCenterTeamOption[];
  a: string;
  b: string;
  gws: number[];
  gw: number;
  onChange: (next: { a: string; b: string; gw: number }) => void;
  accent?: "default" | "continental";
  disabled?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-3 sm:p-4 backdrop-blur">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2 sm:gap-3">
        <TeamSelect
          label="First team"
          teams={teams}
          value={a}
          exclude={b}
          disabled={disabled}
          onChange={(id) => onChange({ a: id, b, gw })}
        />
        <button
          type="button"
          onClick={() => onChange({ a: b, b: a, gw })}
          disabled={disabled}
          aria-label="Swap teams"
          title="Swap teams"
          className="mb-0.5 h-9 w-9 rounded-lg bg-white/10 text-gray-300 hover:bg-white/20 disabled:opacity-40 transition"
        >
          ⇄
        </button>
        <TeamSelect
          label="Second team"
          teams={teams}
          value={b}
          exclude={a}
          disabled={disabled}
          onChange={(id) => onChange({ a, b: id, gw })}
        />
      </div>
      <div className="mt-3">
        <GwNavigator
          gws={gws}
          value={gw}
          onChange={(next) => onChange({ a, b, gw: next })}
          accent={accent}
          disabled={disabled}
          selectLabel="Match Center gameweek"
        />
      </div>
    </div>
  );
}

function TeamSelect({
  label,
  teams,
  value,
  exclude,
  onChange,
  disabled,
}: {
  label: string;
  teams: MatchCenterTeamOption[];
  value: string;
  exclude: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const visible = teams.filter((t) => t.id !== exclude && (!t.isGhost || t.id === value));
  const groups = [...new Set(visible.map((t) => t.group))];
  const hasGroups = groups.some((g) => g != null);

  const option = (t: MatchCenterTeamOption) => (
    <option key={t.id} value={t.id} className="bg-slate-900">
      {t.name}{t.isGhost ? " (ghost)" : ""}
    </option>
  );

  return (
    <label className="block min-w-0">
      <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">{label}</span>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full truncate rounded-lg border border-white/10 bg-white/10 px-2 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-400/50"
      >
        {hasGroups
          ? groups.map((g) => (
              <optgroup key={g ?? "none"} label={g ? `Group ${g}` : "Other"} className="bg-slate-900">
                {visible.filter((t) => t.group === g).map(option)}
              </optgroup>
            ))
          : visible.map(option)}
      </select>
    </label>
  );
}
