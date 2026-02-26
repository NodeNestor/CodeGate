import React from "react";
import { Terminal } from "lucide-react";

interface ProviderGridProps {
  onSelect: (provider: string, method: "api_key" | "terminal") => void;
}

interface FeaturedProvider {
  id: string;
  label: string;
  subtitle: string;
  color: string;
}

interface CompactProvider {
  id: string;
  label: string;
  subtitle: string;
  color: string;
}

const FEATURED_PROVIDERS: FeaturedProvider[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    subtitle: "Claude models",
    color: "bg-orange-500",
  },
  {
    id: "openai",
    label: "OpenAI",
    subtitle: "GPT & Codex",
    color: "bg-green-500",
  },
  {
    id: "gemini",
    label: "Gemini",
    subtitle: "Gemini models",
    color: "bg-yellow-500",
  },
];

const COMPACT_PROVIDERS: CompactProvider[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    subtitle: "Multi-provider gateway",
    color: "bg-purple-500",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    subtitle: "DeepSeek models",
    color: "bg-blue-500",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    subtitle: "Fast inference",
    color: "bg-cyan-500",
  },
  {
    id: "glm",
    label: "GLM",
    subtitle: "Zhipu AI",
    color: "bg-blue-500",
  },
  {
    id: "minimax",
    label: "MiniMax",
    subtitle: "MiniMax models",
    color: "bg-purple-500",
  },
  {
    id: "custom",
    label: "Custom",
    subtitle: "OpenAI-compatible",
    color: "bg-gray-500",
  },
];

function LetterAvatar({
  label,
  color,
  size = "md",
}: {
  label: string;
  color: string;
  size?: "md" | "lg";
}) {
  const sizeClasses =
    size === "lg"
      ? "h-12 w-12 text-xl font-bold"
      : "h-9 w-9 text-sm font-bold";
  return (
    <div
      className={`${sizeClasses} ${color} rounded-xl flex items-center justify-center text-white shrink-0`}
    >
      {label.charAt(0).toUpperCase()}
    </div>
  );
}

export default function ProviderGrid({ onSelect }: ProviderGridProps) {
  return (
    <div className="space-y-6">
      {/* Featured row */}
      <div>
        <p className="text-xs uppercase tracking-wider text-gray-500 mb-3">
          Featured — Login via Terminal
        </p>
        <div className="grid grid-cols-3 gap-3">
          {FEATURED_PROVIDERS.map((provider) => (
            <div
              key={provider.id}
              className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col hover:border-gray-700 transition-colors cursor-pointer group"
              onClick={() => onSelect(provider.id, "terminal")}
            >
              <div className="flex items-center gap-3 mb-3">
                <LetterAvatar
                  label={provider.label}
                  color={provider.color}
                  size="lg"
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-semibold text-gray-100">
                      {provider.label}
                    </span>
                    <Terminal className="h-3.5 w-3.5 text-gray-500 shrink-0" />
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {provider.subtitle}
                  </p>
                </div>
              </div>
              <button
                className="text-xs text-gray-500 hover:text-gray-300 transition-colors text-left mt-auto pt-2 border-t border-gray-800"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(provider.id, "api_key");
                }}
              >
                or use API key
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Compact row */}
      <div>
        <p className="text-xs uppercase tracking-wider text-gray-500 mb-3">
          API Key Providers
        </p>
        <div className="grid grid-cols-3 gap-2">
          {COMPACT_PROVIDERS.map((provider) => (
            <button
              key={provider.id}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 flex items-center gap-2.5 hover:border-gray-600 hover:bg-gray-750 transition-colors text-left w-full"
              onClick={() => onSelect(provider.id, "api_key")}
            >
              <LetterAvatar
                label={provider.label}
                color={provider.color}
                size="md"
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-100 truncate">
                  {provider.label}
                </p>
                <p className="text-xs text-gray-400 truncate">
                  {provider.subtitle}
                </p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
