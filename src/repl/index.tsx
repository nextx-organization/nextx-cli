import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import { resolveConversation } from "../commands/ai.js";
import type { RootFlags } from "../program.js";
import type { ResolvedModel } from "../ai/models.js";

export async function startRepl(opts: { flags: RootFlags; initialQuestion?: string; model?: ResolvedModel }): Promise<void> {
  const sessionId = await resolveConversation(opts.flags);
  const resumed = Boolean(opts.flags.continue || opts.flags.resume);
  const app = render(<App sessionId={sessionId} resumed={resumed} initialQuestion={opts.initialQuestion} files={(opts.flags.file ?? []).slice(0, 3)} model={opts.model} />, {
    exitOnCtrlC: false,
  });
  await app.waitUntilExit();
}
