/**
 * Adapter from the 1.8.0 agent stack to story-graph's minimal completion
 * interface. Uses the "story-graph" modelOverrides key, so extraction can be
 * routed to a cheaper model in inkos.json.
 */
import { BaseAgent } from "../agents/base.js";
import type { GraphCompletion } from "./extract.js";

export class StoryGraphAgent extends BaseAgent {
  get name(): string {
    return "story-graph";
  }

  get model(): string {
    return this.ctx.model;
  }

  readonly complete: GraphCompletion = async (messages, options) => {
    const response = await this.chat(messages.map((message) => ({ role: message.role, content: message.content })), options);
    return response.content;
  };
}
