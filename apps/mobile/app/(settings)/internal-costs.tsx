import type { InternalUsageAmounts, InternalUsageCosts, UsageVendor } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";

const number = (value: number | null) =>
  value === null
    ? "—"
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value);
const usd = (value: number | null) =>
  value === null
    ? "—"
    : new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      }).format(value);

function cost(value: InternalUsageAmounts) {
  return usd(value.costUsd);
}

function Vendor({ vendor }: { vendor: UsageVendor }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState<string | null>(null);
  return (
    <View>
      <SettingsRow
        title={vendor.vendor}
        value={cost(vendor)}
        detail={vendor.priced ? undefined : t("Unpriced usage")}
        chevron={open ? "down" : "right"}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
      />
      {open
        ? vendor.models.map((model) => {
            const key = `${model.unit}:${model.model}`;
            const expanded = key === modelOpen;
            return (
              <View key={key}>
                <SettingsRow
                  title={model.model}
                  value={cost(model)}
                  detail={`${number(model.quantity)} ${model.unit}`}
                  chevron={expanded ? "down" : "right"}
                  accessibilityRole="button"
                  accessibilityState={{ expanded }}
                  onPress={() => setModelOpen(expanded ? null : key)}
                />
                {expanded ? (
                  <SettingsGroup>
                    {model.unit === "tokens" ? (
                      <SettingsRow title={t("Input")} value={number(model.inputTokens)} />
                    ) : null}
                    {model.unit === "tokens" ? (
                      <SettingsRow title={t("Output")} value={number(model.outputTokens)} />
                    ) : null}
                    {model.unit === "tokens" ? (
                      <SettingsRow title={t("Cache read")} value={number(model.cacheReadTokens)} />
                    ) : null}
                    {model.unit === "tokens" ? (
                      <SettingsRow
                        title={t("Cache write")}
                        value={number(model.cacheWriteTokens)}
                      />
                    ) : null}
                    {model.unit === "tokens" ? (
                      <SettingsRow
                        title={t("Cache write (1h)")}
                        value={number(model.cacheWrite1hTokens)}
                      />
                    ) : null}
                    {model.unit === "tokens" ? (
                      <SettingsRow title={t("Reasoning")} value={number(model.reasoningTokens)} />
                    ) : null}
                    {model.unit === "tokens" ? (
                      <SettingsRow title={t("Total tokens")} value={number(model.tokens)} />
                    ) : null}
                    <SettingsRow title={t("Credits")} value={number(model.credits)} />
                    <SettingsRow
                      title={
                        model.unit === "tokens"
                          ? t("Average / 1M tokens")
                          : t("Average / {unit}", { unit: model.unit })
                      }
                      value={usd(model.averageUnitCostUsd)}
                    />
                    <SettingsRow
                      title={t("Cost")}
                      value={cost(model)}
                      detail={model.priced ? model.costSources.join(" · ") : t("Unpriced usage")}
                    />
                  </SettingsGroup>
                ) : null}
              </View>
            );
          })
        : null}
    </View>
  );
}

export default function InternalCosts() {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [data, setData] = useState<InternalUsageCosts | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [accountOpen, setAccountOpen] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setFailed(false);
    void rpc<InternalUsageCosts>("usage/internalCosts").then(
      (value) => {
        if (active) setData(value);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
        {failed ? (
          <SettingsGroup>
            <Text accessibilityRole="alert" style={styles.error}>
              {t("Could not load internal costs")}
            </Text>
            <SettingsRow
              title={t("Retry")}
              accessibilityRole="button"
              onPress={() => setAttempt((value) => value + 1)}
            />
          </SettingsGroup>
        ) : !data ? (
          <Text style={styles.status}>{t("Loading costs…")}</Text>
        ) : (
          <>
            <SettingsGroup label={t("All accounts")}>
              <SettingsRow
                title={t("This month")}
                value={cost(data.month)}
                detail={`${number(data.month.credits)} ${t("credits")}`}
              />
              <SettingsRow
                title={t("All time")}
                value={cost(data.total)}
                detail={`${number(data.total.credits)} ${t("credits")}${data.total.priced ? "" : ` · ${t("Unpriced usage")}`}`}
              />
            </SettingsGroup>
            <SettingsGroup label={t("By vendor")}>
              {data.vendors.map((vendor) => (
                <Vendor key={vendor.vendor} vendor={vendor} />
              ))}
            </SettingsGroup>
            <SettingsGroup label={t("Accounts")}>
              {data.accounts.map((account) => (
                <View key={account.userId}>
                  <SettingsRow
                    title={account.email ?? account.name ?? account.userId}
                    value={cost(account)}
                    detail={`${number(account.credits)} ${t("credits")}`}
                    chevron={accountOpen === account.userId ? "down" : "right"}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: accountOpen === account.userId }}
                    onPress={() =>
                      setAccountOpen(accountOpen === account.userId ? null : account.userId)
                    }
                  />
                  {accountOpen === account.userId ? (
                    account.vendors.length ? (
                      account.vendors.map((vendor) => (
                        <Vendor key={vendor.vendor} vendor={vendor} />
                      ))
                    ) : (
                      <SettingsRow title={t("No usage yet")} />
                    )
                  ) : null}
                </View>
              ))}
            </SettingsGroup>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { padding: 20, gap: 24 },
    status: { color: native.secondaryLabel, padding: 16 },
    error: { color: mobileTokens().destructive, padding: 16 },
  });
}
