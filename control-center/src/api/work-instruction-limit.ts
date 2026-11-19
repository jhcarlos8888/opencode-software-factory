/**
 * Single source of truth for the initial and follow-up work chat.
 * Separate from tool answers, approval receipts and log truncation limits.
 */
export const MAX_WORK_INSTRUCTION_CHARS = 24_000;

export function workInstructionLimitError(instructions: string): string | null {
  return instructions.length > MAX_WORK_INSTRUCTION_CHARS
    ? `La instrucción supera el máximo de ${MAX_WORK_INSTRUCTION_CHARS.toLocaleString("es-CO")} caracteres. Reduce el texto antes de enviarlo.`
    : null;
}
