import { Trans } from "@lingui/react/macro";
import { createContext, useContext } from "react";

/** Jumps to the conversation's card that is waiting now; the transcript provides it when one is. */
export const JumpToActiveAskContext = createContext<(() => void) | undefined>(undefined);

/** A card nobody can answer any more, pointing to the one that replaced it when there is one. */
export function InactiveAsk() {
  const jump = useContext(JumpToActiveAskContext);
  return (
    <>
      <Trans>No longer active</Trans>
      {jump ? (
        <>
          {" · "}
          <button type="button" className="underline underline-offset-2" onClick={jump}>
            <Trans>Needs an answer</Trans>
          </button>
        </>
      ) : null}
    </>
  );
}
