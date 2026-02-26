import React from "react";

interface BadgeProps {
  variant?:
    | "default"
    | "success"
    | "warning"
    | "danger"
    | "info"
    | "purple"
    | "orange"
    | "cyan";
  children: React.ReactNode;
  className?: string;
}

const variantClasses: Record<string, string> = {
  default: "bg-gray-500/10 text-gray-400 ring-gray-500/20",
  success: "bg-green-500/10 text-green-400 ring-green-500/20",
  warning: "bg-yellow-500/10 text-yellow-400 ring-yellow-500/20",
  danger: "bg-red-500/10 text-red-400 ring-red-500/20",
  info: "bg-blue-500/10 text-blue-400 ring-blue-500/20",
  purple: "bg-purple-500/10 text-purple-400 ring-purple-500/20",
  orange: "bg-orange-500/10 text-orange-400 ring-orange-500/20",
  cyan: "bg-cyan-500/10 text-cyan-400 ring-cyan-500/20",
};

const providerVariant: Record<string, string> = {
  anthropic: "orange",
  openai: "success",
  openai_sub: "success",
  openrouter: "purple",
  glm: "info",
  cerebras: "cyan",
  deepseek: "info",
  gemini: "warning",
  minimax: "purple",
  custom: "default",
};

export function getProviderVariant(
  provider: string
): BadgeProps["variant"] {
  return (providerVariant[provider] || "default") as BadgeProps["variant"];
}

/** Map provider key to display label */
export function getProviderLabel(provider: string): string {
  const labels: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    openai_sub: "OpenAI Sub",
    openrouter: "OpenRouter",
    glm: "GLM",
    cerebras: "Cerebras",
    deepseek: "DeepSeek",
    gemini: "Gemini",
    minimax: "MiniMax",
    custom: "Custom",
  };
  return labels[provider] || provider;
}

/** Map account status to badge variant */
export function getStatusVariant(
  status?: string
): BadgeProps["variant"] {
  switch (status) {
    case "active":
      return "success";
    case "expired":
      return "danger";
    case "rate_limited":
      return "warning";
    case "error":
      return "danger";
    default:
      return "default";
  }
}

/** Map account status to display label */
export function getStatusLabel(status?: string): string {
  switch (status) {
    case "active":
      return "Active";
    case "expired":
      return "Expired";
    case "rate_limited":
      return "Rate Limited";
    case "error":
      return "Error";
    case "unknown":
    default:
      return "Unknown";
  }
}

export default function Badge({
  variant = "default",
  children,
  className = "",
}: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${variantClasses[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
