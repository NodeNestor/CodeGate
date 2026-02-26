import React, { useState } from "react";
import Modal from "./ui/Modal";
import ProviderGrid from "./ProviderGrid";
import ApiKeyQuickForm from "./ApiKeyQuickForm";
import TerminalLoginFlow from "./TerminalLoginFlow";

interface ConnectAccountWizardProps {
  open: boolean;
  onClose: () => void;
  onAccountCreated: () => void;
}

type Step =
  | { type: "grid" }
  | { type: "api_key"; provider: string }
  | { type: "terminal"; provider: "anthropic" | "openai" | "gemini" };

const TERMINAL_PROVIDERS = new Set(["anthropic", "openai", "gemini"]);

export default function ConnectAccountWizard({
  open,
  onClose,
  onAccountCreated,
}: ConnectAccountWizardProps) {
  const [step, setStep] = useState<Step>({ type: "grid" });

  function handleSelect(provider: string, method: "api_key" | "terminal") {
    if (method === "terminal" && TERMINAL_PROVIDERS.has(provider)) {
      setStep({ type: "terminal", provider: provider as "anthropic" | "openai" | "gemini" });
    } else {
      setStep({ type: "api_key", provider });
    }
  }

  function handleSuccess() {
    onAccountCreated();
    handleClose();
  }

  function handleClose() {
    setStep({ type: "grid" });
    onClose();
  }

  const title =
    step.type === "grid"
      ? "Connect Account"
      : step.type === "api_key"
        ? undefined // ApiKeyQuickForm has its own header
        : undefined; // TerminalLoginFlow has its own header

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={title}
      maxWidth={step.type === "terminal" ? "max-w-4xl" : "max-w-2xl"}
    >
      {step.type === "grid" && <ProviderGrid onSelect={handleSelect} />}

      {step.type === "api_key" && (
        <ApiKeyQuickForm
          provider={step.provider}
          onSubmit={handleSuccess}
          onBack={() => setStep({ type: "grid" })}
        />
      )}

      {step.type === "terminal" && (
        <TerminalLoginFlow
          provider={step.provider}
          onSuccess={handleSuccess}
          onBack={() => setStep({ type: "grid" })}
        />
      )}
    </Modal>
  );
}
