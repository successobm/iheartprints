"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";

interface ComposerProps {
  disabled: boolean;
  placeholder: string;
  onSend: (content: string) => Promise<void> | void;
}

export function Composer({ disabled, placeholder, onSend }: ComposerProps) {
  const [value, setValue] = useState("");

  async function submit() {
    const content = value.trim();
    if (!content || disabled) return;
    setValue("");
    await onSend(content);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void submit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto w-full max-w-2xl px-4 pb-6">
      <div className="flex items-end gap-2 rounded-3xl border border-black/8 bg-white p-2 shadow-sm">
        <textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={disabled}
          placeholder={placeholder}
          className="max-h-40 min-h-[48px] flex-1 resize-none bg-transparent px-3 py-3 text-[15px] text-ink outline-none placeholder:text-muted disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={disabled || !value.trim()}
          className="mb-1 mr-1 rounded-full bg-ink px-4 py-2.5 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </form>
  );
}
