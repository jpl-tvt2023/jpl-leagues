"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { LoadingScreen } from "@/components/LoadingScreen";

interface SetupState {
  teamName: string;
  abbreviation: string;
  player1Name: string;
  player1FplId: string;
  player2Name: string;
  player2FplId: string;
}

interface Errors {
  teamName?: string;
  abbreviation?: string;
  player1Name?: string;
  player1FplId?: string;
  player2Name?: string;
  player2FplId?: string;
  global?: string;
}

type Step = 1 | 2 | 3;

export default function SetupPage() {
  const router = useRouter();

  const [isLoading, setIsLoading] = useState(true);
  const [currentStep, setCurrentStep] = useState<Step>(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [nameCheckLoading, setNameCheckLoading] = useState(false);

  const [formData, setFormData] = useState<SetupState>({
    teamName: "",
    abbreviation: "",
    player1Name: "",
    player1FplId: "",
    player2Name: "",
    player2FplId: "",
  });

  const [currentTeamName, setCurrentTeamName] = useState<string>("");

  // Check auth and load current team info
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await fetch("/api/auth/me");
        const me = await res.json();

        if (!me.authenticated || me.type !== "team") {
          router.push("/signin");
          return;
        }

        // If already completed setup, redirect to dashboard
        if (me.team.isProfileComplete) {
          router.push("/dashboard");
          return;
        }

        // Fetch current setup info for prefilling
        const setupRes = await fetch("/api/team/setup");
        if (setupRes.ok) {
          const setupData = await setupRes.json();
          setCurrentTeamName(setupData.currentName);
          setFormData((prev) => ({
            ...prev,
            teamName: setupData.currentName,
            abbreviation: setupData.currentAbbreviation,
          }));
        }
      } catch (err) {
        console.error("Auth check error:", err);
        router.push("/signin");
      } finally {
        setIsLoading(false);
      }
    };

    checkAuth();
  }, [router]);

  const handleTeamNameBlur = async (value: string) => {
    if (!value.trim() || value === currentTeamName) return;

    setNameCheckLoading(true);
    try {
      const res = await fetch(`/api/team/setup?checkName=${encodeURIComponent(value)}`);
      const data = await res.json();
      if (!data.available) {
        setErrors((prev) => ({ ...prev, teamName: "Team name is already taken" }));
      } else {
        setErrors((prev) => ({ ...prev, teamName: undefined }));
      }
    } catch (err) {
      console.error("Name check error:", err);
    } finally {
      setNameCheckLoading(false);
    }
  };

  const validateStep1 = () => {
    const newErrors: Errors = {};

    if (!formData.teamName.trim()) {
      newErrors.teamName = "Team name is required";
    }

    if (!formData.abbreviation.trim()) {
      newErrors.abbreviation = "Abbreviation is required";
    } else if (!/^[A-Z]{2,4}$/.test(formData.abbreviation)) {
      newErrors.abbreviation = "Must be 2-4 uppercase letters";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const validateStep2 = () => {
    const newErrors: Errors = {};

    if (!formData.player1Name.trim()) {
      newErrors.player1Name = "Player name is required";
    }

    if (!formData.player1FplId.trim()) {
      newErrors.player1FplId = "FPL ID is required";
    } else if (!/^\d+$/.test(formData.player1FplId)) {
      newErrors.player1FplId = "Must be numeric";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const validateStep3 = () => {
    const newErrors: Errors = {};

    if (!formData.player2Name.trim()) {
      newErrors.player2Name = "Player name is required";
    }

    if (!formData.player2FplId.trim()) {
      newErrors.player2FplId = "FPL ID is required";
    } else if (!/^\d+$/.test(formData.player2FplId)) {
      newErrors.player2FplId = "Must be numeric";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleNext = () => {
    let isValid = false;
    if (currentStep === 1) isValid = validateStep1();
    else if (currentStep === 2) isValid = validateStep2();

    if (isValid && currentStep < 3) {
      setCurrentStep((currentStep + 1) as Step);
      setErrors({});
    }
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep((currentStep - 1) as Step);
      setErrors({});
    }
  };

  const handleInputChange = (field: keyof SetupState, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));

    // Auto-uppercase abbreviation
    if (field === "abbreviation") {
      setFormData((prev) => ({ ...prev, abbreviation: value.toUpperCase() }));
    }
  };

  const handleCompleteSetup = async () => {
    if (!validateStep3()) return;

    setIsSubmitting(true);
    try {
      const res = await fetch("/api/team/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      const data = await res.json();

      if (!res.ok) {
        setErrors({ global: data.error || "Setup failed" });
        return;
      }

      // Redirect to dashboard on success
      router.push("/dashboard");
    } catch (err) {
      console.error("Setup error:", err);
      setErrors({ global: "Failed to complete setup" });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return <LoadingScreen variant="standings" fullScreen />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900 px-4 py-8 sm:px-6 lg:px-12">
      <div className="mx-auto max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">Complete Your Profile</h1>
          <p className="text-gray-400 text-sm">Step {currentStep} of 3</p>
        </div>

        {/* Progress indicator */}
        <div className="flex gap-2 mb-12">
          {[1, 2, 3].map((step) => (
            <div
              key={step}
              className={`h-1 flex-1 rounded-full transition-colors ${
                step <= currentStep ? "bg-gradient-to-r from-yellow-400 to-orange-500" : "bg-white/10"
              }`}
            />
          ))}
        </div>

        {/* Error message */}
        {errors.global && (
          <div className="mb-6 p-4 rounded-lg bg-red-500/20 border border-red-500/50 text-red-300 text-sm">
            {errors.global}
          </div>
        )}

        {/* Form */}
        <div className="rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur">
          {currentStep === 1 && (
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-semibold text-white mb-2">Team Name</label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={formData.teamName}
                    onChange={(e) => handleInputChange("teamName", e.target.value)}
                    onBlur={(e) => handleTeamNameBlur(e.target.value)}
                    placeholder={currentTeamName}
                    className="flex-1 rounded-lg border border-white/20 bg-black/40 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-400 focus:outline-none"
                  />
                  {nameCheckLoading && <span className="text-xs text-gray-400">Checking...</span>}
                </div>
                {errors.teamName && <p className="text-red-400 text-xs mt-1">{errors.teamName}</p>}
                <p className="text-gray-500 text-xs mt-2">
                  This replaces your temporary name and must be unique.
                </p>
              </div>

              <div>
                <label className="block text-sm font-semibold text-white mb-2">Abbreviation</label>
                <input
                  type="text"
                  value={formData.abbreviation}
                  onChange={(e) => handleInputChange("abbreviation", e.target.value)}
                  placeholder="DM"
                  maxLength={4}
                  className="w-full rounded-lg border border-white/20 bg-black/40 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-400 focus:outline-none"
                />
                {errors.abbreviation && <p className="text-red-400 text-xs mt-1">{errors.abbreviation}</p>}
                <p className="text-gray-500 text-xs mt-2">2-4 uppercase letters (e.g., DM, TEAM)</p>
              </div>
            </div>
          )}

          {currentStep === 2 && (
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-semibold text-white mb-2">Player 1 Name</label>
                <input
                  type="text"
                  value={formData.player1Name}
                  onChange={(e) => handleInputChange("player1Name", e.target.value)}
                  placeholder="John Doe"
                  className="w-full rounded-lg border border-white/20 bg-black/40 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-400 focus:outline-none"
                />
                {errors.player1Name && <p className="text-red-400 text-xs mt-1">{errors.player1Name}</p>}
              </div>

              <div>
                <label className="block text-sm font-semibold text-white mb-2">Player 1 FPL Team ID</label>
                <input
                  type="text"
                  value={formData.player1FplId}
                  onChange={(e) => handleInputChange("player1FplId", e.target.value)}
                  placeholder="1234567"
                  className="w-full rounded-lg border border-white/20 bg-black/40 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-400 focus:outline-none"
                />
                {errors.player1FplId && <p className="text-red-400 text-xs mt-1">{errors.player1FplId}</p>}
                <p className="text-gray-500 text-xs mt-2">
                  Find it at{" "}
                  <a href="https://fantasy.premierleague.com" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300">
                    fantasy.premierleague.com
                  </a>
                </p>
              </div>
            </div>
          )}

          {currentStep === 3 && (
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-semibold text-white mb-2">Player 2 Name</label>
                <input
                  type="text"
                  value={formData.player2Name}
                  onChange={(e) => handleInputChange("player2Name", e.target.value)}
                  placeholder="Jane Smith"
                  className="w-full rounded-lg border border-white/20 bg-black/40 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-400 focus:outline-none"
                />
                {errors.player2Name && <p className="text-red-400 text-xs mt-1">{errors.player2Name}</p>}
              </div>

              <div>
                <label className="block text-sm font-semibold text-white mb-2">Player 2 FPL Team ID</label>
                <input
                  type="text"
                  value={formData.player2FplId}
                  onChange={(e) => handleInputChange("player2FplId", e.target.value)}
                  placeholder="7654321"
                  className="w-full rounded-lg border border-white/20 bg-black/40 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-400 focus:outline-none"
                />
                {errors.player2FplId && <p className="text-red-400 text-xs mt-1">{errors.player2FplId}</p>}
                <p className="text-gray-500 text-xs mt-2">
                  Find it at{" "}
                  <a href="https://fantasy.premierleague.com" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300">
                    fantasy.premierleague.com
                  </a>
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Navigation buttons */}
        <div className="mt-8 flex gap-4">
          <button
            onClick={handleBack}
            disabled={currentStep === 1}
            className="flex-1 px-6 py-3 rounded-lg border border-white/20 text-white font-semibold hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            Back
          </button>

          {currentStep < 3 ? (
            <button
              onClick={handleNext}
              className="flex-1 px-6 py-3 rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 text-slate-900 font-bold hover:from-yellow-300 hover:to-orange-400 transition"
            >
              Next
            </button>
          ) : (
            <button
              onClick={handleCompleteSetup}
              disabled={isSubmitting}
              className="flex-1 px-6 py-3 rounded-lg bg-gradient-to-r from-green-400 to-emerald-500 text-white font-bold hover:from-green-300 hover:to-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {isSubmitting ? "Completing..." : "Complete Setup"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
