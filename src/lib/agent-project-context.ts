export type AgentProjectContext = {
  id: string;
  name: string;
  instructions?: string;
};

export type PreparedProjectPrompt = {
  text: string;
  injected: boolean;
  contextSignature: string | null;
};

function projectContextSignature(project: AgentProjectContext): string {
  return JSON.stringify([project.id, project.name, project.instructions ?? ""]);
}

export function prepareProjectPrompt(
  prompt: string,
  project: AgentProjectContext | undefined,
  previousContextSignature: string | null | undefined,
): PreparedProjectPrompt {
  if (!project) {
    return { text: prompt, injected: false, contextSignature: null };
  }

  const contextSignature = projectContextSignature(project);
  if (contextSignature === previousContextSignature) {
    return { text: prompt, injected: false, contextSignature };
  }

  const instructions = project.instructions?.trim() || "(none)";
  const context = [
    "[June project context]",
    `project_id: ${project.id}`,
    `project: ${project.name}`,
    "instructions:",
    instructions,
    "[/June project context]",
  ].join("\n");
  return {
    text: `${context}\n\n${prompt}`,
    injected: true,
    contextSignature,
  };
}

export function stripProjectContext(prompt: string): string {
  if (!prompt.startsWith("[June project context]\n")) return prompt;
  const endMarker = "\n[/June project context]\n\n";
  const end = prompt.indexOf(endMarker);
  return end < 0 ? prompt : prompt.slice(end + endMarker.length);
}
