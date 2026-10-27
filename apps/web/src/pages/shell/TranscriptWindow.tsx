import type { ReactNode, RefObject } from "react";
import { Fragment } from "react";
import { lazyPanel } from "../../components/ErrorBoundary";

export interface TranscriptWindowProps<T> {
  items: readonly T[];
  itemKey: (item: T) => string;
  containsMessage: (item: T, id: string) => boolean;
  renderItem: (item: T) => ReactNode;
  scrollRef: RefObject<HTMLDivElement | null>;
  following: RefObject<boolean>;
  jumpMessageId?: string;
}

const VirtualTranscriptWindow = lazyPanel(() =>
  import("./VirtualTranscriptWindow").then((module) => module.VirtualTranscriptWindow),
);

/** Small transcripts render directly; load windowing only when the existing threshold applies. */
export function TranscriptWindow<T>(props: TranscriptWindowProps<T>) {
  if (props.items.length <= 80)
    return props.items.map((item) => (
      <Fragment key={props.itemKey(item)}>{props.renderItem(item)}</Fragment>
    ));
  const Window = VirtualTranscriptWindow as (props: TranscriptWindowProps<T>) => ReactNode;
  return <Window {...props} />;
}
