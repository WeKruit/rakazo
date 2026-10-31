import { MenuView } from "@expo/ui/community/menu";
import type { RecruitingAccountViewOutput, RecruitingRoleCampaign } from "@rakazo/contracts";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { NativeActionButton } from "../components/native-action-button";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";

/** Mobile uses the same account read; interviews use the native agenda list. */
export default function RecruitingScreen() {
  const { t } = useI18n();
  const params = useLocalSearchParams<{ view?: string; role?: string }>();
  const router = useRouter();
  const view = params.view === "sequence" ? "sequence" : "interview";
  const role = params.role ?? "all";
  const [page, setPage] = useState<RecruitingAccountViewOutput>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const pageKey = JSON.stringify([view, role]);
  const [pagination, setPagination] = useState<{ key: string; cursor: string }>();
  const cursor = pagination?.key === pageKey ? pagination.cursor : undefined;
  const styles = useThemedStyles(() =>
    StyleSheet.create({
      page: { flex: 1, backgroundColor: native.page },
      content: { padding: 16, gap: 16 },
      section: { padding: 16, gap: 8, borderRadius: 12, backgroundColor: native.groupedCell },
      title: { fontSize: 18, fontWeight: "600", color: native.label },
      text: { fontSize: 15, color: native.label },
      muted: { fontSize: 13, color: native.secondaryLabel },
    }),
  );
  useEffect(() => {
    let cancelled = false;
    setPage(undefined);
    setFailed(false);
    void rpc<RecruitingAccountViewOutput>("recruiting/accountView", {
      view,
      ...(role !== "all" ? { roleId: role } : {}),
      cursor,
      limit: 20,
    })
      .then((value) => {
        if (!cancelled) setPage(value);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [view, role, cursor, reload]);
  const loadMoreLeads = async (roleId: string, campaign: RecruitingRoleCampaign) => {
    if (
      !page ||
      !campaign.campaign ||
      !campaign.serverId ||
      !campaign.nextLeadCursor ||
      loadingMore
    )
      return;
    const previous = page;
    setLoadingMore(true);
    try {
      const next = await rpc<RecruitingAccountViewOutput>("recruiting/accountView", {
        view: "sequence",
        roleId,
        campaignId: campaign.campaign.id,
        campaignServerId: campaign.serverId,
        campaignLeadCursor: campaign.nextLeadCursor,
        limit: 20,
      });
      const update = next.items[0]?.campaigns?.[0];
      if (update)
        setPage((current) =>
          current !== previous
            ? current
            : {
                ...current,
                items: current.items.map((item) =>
                  item.roleId !== roleId
                    ? item
                    : {
                        ...item,
                        campaigns: (item.campaigns ?? (item.campaign ? [item.campaign] : [])).map(
                          (saved) =>
                            saved.serverId === update.serverId &&
                            saved.campaign?.id === update.campaign?.id
                              ? {
                                  ...update,
                                  leads: [
                                    ...new Map(
                                      [...saved.leads, ...update.leads].map((lead) => [
                                        lead.email.toLowerCase(),
                                        lead,
                                      ]),
                                    ).values(),
                                  ],
                                }
                              : saved,
                        ),
                      },
                ),
              },
        );
    } catch {
      setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };
  const loadMoreInterviews = async (roleId: string, itemCursor: string) => {
    if (!page || loadingMore) return;
    const previous = page;
    setLoadingMore(true);
    try {
      const next = await rpc<RecruitingAccountViewOutput>("recruiting/accountView", {
        view: "interview",
        roleId,
        itemCursor,
        limit: 20,
      });
      const update = next.items[0]?.correspondence;
      if (update)
        setPage((current) =>
          current !== previous
            ? current
            : {
                ...current,
                items: current.items.map((item) =>
                  item.roleId !== roleId
                    ? item
                    : {
                        ...item,
                        correspondence: {
                          ...update,
                          events: [
                            ...new Map(
                              [...(item.correspondence?.events ?? []), ...update.events].map(
                                (event) => [event.id, event],
                              ),
                            ).values(),
                          ],
                        },
                      },
                ),
              },
        );
    } catch {
      setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };
  return (
    <View style={styles.page}>
      <Stack.Screen options={{ title: view === "interview" ? t("Interview") : t("Sequence") }} />
      <ScrollView contentContainerStyle={styles.content}>
        <MenuView
          actions={[
            { id: "all", title: t("All roles") },
            ...(page?.roles ?? []).map((item) => ({ id: item.id, title: item.title })),
          ]}
          onPressAction={({ nativeEvent }) => router.setParams({ role: nativeEvent.event })}
        >
          <NativeActionButton
            label={page?.roles.find((item) => item.id === role)?.title ?? t("All roles")}
            prominence="secondary"
            onPress={() => {}}
          />
        </MenuView>
        {!page && !failed ? <ActivityIndicator /> : null}
        {failed ? (
          <NativeActionButton
            label={t("Try again.")}
            onPress={() => setReload((value) => value + 1)}
          />
        ) : null}
        {page?.items.length === 0 ? <Text style={styles.muted}>{t("No roles yet.")}</Text> : null}
        {page?.items.map((item) => {
          const needsCalendar = item.correspondence?.connections.every(
            (connection) => connection.status === "needs_connection",
          );
          const calendarFailed =
            !needsCalendar &&
            (!["ready", "empty"].includes(item.correspondence?.status ?? "not_checked") ||
              (item.correspondence?.partial && !item.correspondence.nextCursor) ||
              item.correspondence?.connections.some(
                (connection) =>
                  connection.checkIssue?.status === "failed" ||
                  !["configured", "needs_connection"].includes(connection.status),
              ));
          const campaigns = item.campaigns ?? (item.campaign?.campaign ? [item.campaign] : []);
          const campaignFailed =
            item.campaign?.status === "unavailable" ||
            campaigns.some((campaign) => campaign.status === "unavailable");
          return (
            <View key={item.roleId} style={styles.section}>
              <Text style={styles.title}>
                {page.roles.find((entry) => entry.id === item.roleId)?.title}
              </Text>
              {view === "interview" ? (
                <>
                  {needsCalendar ? (
                    <NativeActionButton
                      label={t("Connect calendar")}
                      prominence="secondary"
                      onPress={() => router.push("/integrations")}
                    />
                  ) : null}
                  {calendarFailed ? (
                    <>
                      <Text style={styles.muted}>{t("Could not load calendar records.")}</Text>
                      <NativeActionButton
                        label={t("Try again.")}
                        onPress={() => setReload((value) => value + 1)}
                      />
                    </>
                  ) : null}
                  {!calendarFailed &&
                  !needsCalendar &&
                  !item.correspondence?.events.length &&
                  !item.correspondence?.nextCursor ? (
                    <Text style={styles.muted}>{t("No interviews yet.")}</Text>
                  ) : null}
                  {item.correspondence?.events.map((event) => (
                    <View key={event.id}>
                      <Text style={styles.text}>{event.title}</Text>
                      <Text style={styles.muted}>
                        {new Date(event.start).toLocaleString()} · {event.status}
                      </Text>
                      <Text style={styles.muted}>{event.attendees.join(", ")}</Text>
                    </View>
                  ))}
                  {item.correspondence?.nextCursor ? (
                    <NativeActionButton
                      label={t("Load more")}
                      prominence="secondary"
                      disabled={loadingMore}
                      onPress={() =>
                        void loadMoreInterviews(item.roleId, item.correspondence!.nextCursor!)
                      }
                    />
                  ) : null}
                </>
              ) : (
                <>
                  {campaignFailed ? (
                    <>
                      <Text style={styles.muted}>{t("Could not read this campaign.")}</Text>
                      <NativeActionButton
                        label={t("Try again.")}
                        onPress={() => setReload((value) => value + 1)}
                      />
                    </>
                  ) : !campaigns.length ? (
                    <Text style={styles.muted}>{t("No campaign yet.")}</Text>
                  ) : null}
                  {campaigns.map((campaign) => (
                    <View key={campaign.campaign?.id ?? "none"}>
                      <Text style={styles.text}>{campaign.campaign?.name}</Text>
                      <Text style={styles.muted}>
                        {t("Sent")} {campaign.stats?.sent ?? "—"} · {t("Opened")}{" "}
                        {campaign.stats?.opened ?? "—"} · {t("Replied")}{" "}
                        {campaign.stats?.replied ?? "—"}
                      </Text>
                      {campaign.nextLeadCursor ? (
                        <NativeActionButton
                          label={t("Load more")}
                          prominence="secondary"
                          disabled={loadingMore}
                          onPress={() => void loadMoreLeads(item.roleId, campaign)}
                        />
                      ) : null}
                      {campaign.leads.map((lead) => (
                        <Text key={lead.email} style={styles.muted}>
                          {lead.email}
                        </Text>
                      ))}
                    </View>
                  ))}
                  {item.correspondence?.contacts.map((contact) => (
                    <Text key={contact.candidateKey} style={styles.text}>
                      {contact.emails.map((email) => email.address).join(", ")}
                    </Text>
                  ))}
                </>
              )}
            </View>
          );
        })}
        {page?.nextCursor ? (
          <NativeActionButton
            label={t("Next page")}
            prominence="secondary"
            onPress={() => setPagination({ key: pageKey, cursor: page.nextCursor! })}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}
