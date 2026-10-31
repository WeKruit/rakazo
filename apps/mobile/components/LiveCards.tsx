import type { MessageBlock } from "@rakazo/contracts";
import { canvasDocument, canvasSaveState } from "@rakazo/core";
import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { native, useMobileTokens } from "../lib/native";
import { useThreadReadOnly } from "../lib/thread-read-only";
import { PollCard } from "./PollCard";
import { SandboxedHtmlPreview } from "./sandboxed-html-preview";

type LiveCardBlock = Extract<MessageBlock, { kind: "poll" | "canvas" | "view" }>;
type Target = { botId: string } | { groupId: string };

export function isLiveCardBlock(block: MessageBlock): block is LiveCardBlock {
  return block.kind === "poll" || block.kind === "canvas" || block.kind === "view";
}

/** Cards an agent keeps live in the conversation: polls, canvases and record views. */
export function LiveCards({ blocks, target }: { blocks: LiveCardBlock[]; target: Target }) {
  return blocks.map((block, index) =>
    block.kind === "poll" ? (
      <PollCard key={block.pollId} target={target} block={block} />
    ) : block.kind === "canvas" ? (
      <CanvasCard key={`${block.canvasId}:${block.revision}`} target={target} block={block} />
    ) : (
      <ViewCard key={`view-${index}`} block={block} />
    ),
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 18, overflow: "hidden", gap: 8 },
  title: { fontSize: 15, fontWeight: "600", paddingHorizontal: 16, paddingTop: 12 },
  frame: { height: 380 },
  metric: { borderRadius: 12, minWidth: 120, paddingHorizontal: 12, paddingVertical: 10 },
  small: { fontSize: 12 },
  value: { fontSize: 20, fontVariant: ["tabular-nums"], fontWeight: "600" },
  lane: { borderRadius: 12, gap: 6, padding: 8, width: 220 },
  item: { borderRadius: 8, gap: 2, padding: 8 },
  row: { flexDirection: "row", paddingVertical: 6 },
  cell: { fontSize: 13, paddingHorizontal: 6, width: 130 },
});

/** The app's saved data is read once per revision, so its own saves never reload it. */
function CanvasCard({
  target,
  block,
}: {
  target: Target;
  block: Extract<MessageBlock, { kind: "canvas" }>;
}) {
  const tokens = useMobileTokens();
  const readOnly = useThreadReadOnly();
  const [document] = useState(() => canvasDocument(block.html, block.state));
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  function save(data: string) {
    const saved = canvasSaveState(data);
    if (!saved || readOnly) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void rpc("threads/saveCanvasState", {
        ...target,
        canvasId: block.canvasId,
        state: saved.state,
      }).catch(() => undefined);
    }, 600);
  }
  return (
    <View style={[styles.card, { backgroundColor: native.fill }]}>
      <Text numberOfLines={1} style={[styles.title, { color: tokens.foreground }]}>
        {block.title}
      </Text>
      <View style={styles.frame}>
        <SandboxedHtmlPreview html={document} onMessage={save} />
      </View>
    </View>
  );
}

function ViewCard({ block }: { block: Extract<MessageBlock, { kind: "view" }> }) {
  const tokens = useMobileTokens();
  const cell = (value: unknown) => (value === null || value === undefined ? "" : String(value));
  const title = block.title ? (
    <Text style={{ color: tokens.foreground, fontSize: 15, fontWeight: "600" }}>{block.title}</Text>
  ) : null;
  if (block.layout === "metrics")
    return (
      <View style={{ gap: 8 }}>
        {title}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {block.metrics.map((metric) => (
            <View key={metric.label} style={[styles.metric, { backgroundColor: native.fill }]}>
              <Text style={[styles.small, { color: tokens.mutedForeground }]}>{metric.label}</Text>
              <Text style={[styles.value, { color: tokens.foreground }]}>{metric.value}</Text>
              {metric.detail ? (
                <Text style={[styles.small, { color: tokens.mutedForeground }]}>
                  {metric.detail}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      </View>
    );
  const columns = block.columns.length
    ? block.columns
    : Object.keys(block.rows[0] ?? {}).map((key) => ({ key, label: key }));
  if (block.layout === "board") {
    const groupBy = block.groupBy ?? "";
    const lanes = [...new Set(block.rows.map((row) => cell(row[groupBy])))];
    const shown = columns.filter((column) => column.key !== groupBy);
    return (
      <View style={{ gap: 8 }}>
        {title}
        <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
          {lanes.map((lane) => {
            const rows = block.rows.filter((row) => cell(row[groupBy]) === lane);
            return (
              <View key={lane} style={[styles.lane, { backgroundColor: native.fill }]}>
                <Text style={{ color: tokens.foreground, fontSize: 13, fontWeight: "600" }}>
                  {`${lane || "—"} · ${rows.length}`}
                </Text>
                {rows.map((row, index) => (
                  <View key={index} style={[styles.item, { backgroundColor: tokens.background }]}>
                    {shown.map((column, at) => (
                      <Text
                        key={column.key}
                        style={{
                          color: at ? tokens.mutedForeground : tokens.foreground,
                          fontSize: 13,
                          fontWeight: at ? "400" : "500",
                        }}
                      >
                        {cell(row[column.key])}
                      </Text>
                    ))}
                  </View>
                ))}
              </View>
            );
          })}
        </ScrollView>
      </View>
    );
  }
  return (
    <View style={{ gap: 8 }}>
      {title}
      <ScrollView horizontal>
        <View>
          <View style={[styles.row, { borderBottomColor: tokens.border, borderBottomWidth: 1 }]}>
            {columns.map((column) => (
              <Text key={column.key} style={[styles.cell, { color: tokens.mutedForeground }]}>
                {column.label}
              </Text>
            ))}
          </View>
          {block.rows.map((row, index) => (
            <View
              key={index}
              style={[styles.row, { borderBottomColor: tokens.border, borderBottomWidth: 1 }]}
            >
              {columns.map((column) => (
                <Text key={column.key} style={[styles.cell, { color: tokens.foreground }]}>
                  {cell(row[column.key])}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
