import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

// On "start": call `effect`, then `ask_question`.
// Any other message gets a plain reply.
export default defineAgent({
  model: mockModel(async ({ messages, lastUserMessage }) => {
    if (lastUserMessage !== "start") return "ok";
    const steps = messages.slice(messages.findLastIndex((m) => m.role === "user")).filter((m) => m.role === "tool").length;
    if (steps === 0) return { toolCalls: [{ name: "effect", input: {} }] };
    if (steps > 1) return "done";
    return { toolCalls: [{ name: "ask_question", input: { question: "Continue?", options: [{ label: "yes", description: "Yes." }, { label: "no", description: "No." }] } }] };
  }),
});
