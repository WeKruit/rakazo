import type { ThreadMessage } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { createContext } from "react";
import type { AskBlock } from "./AskCard";

/**
 * Extra inputs for one open card in the transcript (votes on a calibration round's people). The
 * conversation that knows the role supplies them; `answer` answers that card with plain text.
 */
export type AskPanel = (
  message: ThreadMessage,
  block: AskBlock,
  answer: (text: string) => Promise<boolean>,
) => ReactNode;

export const AskPanelContext = createContext<AskPanel | null>(null);
