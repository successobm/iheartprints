"use client";

import type { ConversationMessage } from "@/lib/domain/types";

interface MessageBubbleProps {
  message: ConversationMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={[
          "max-w-[85%] rounded-2xl px-4 py-3 text-[15px] leading-relaxed",
          isUser
            ? "bg-ink text-white"
            : "bg-white text-ink shadow-sm ring-1 ring-black/5",
        ].join(" ")}
      >
        {message.content}
      </div>
    </div>
  );
}
