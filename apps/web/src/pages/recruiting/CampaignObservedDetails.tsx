import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingCampaignDetails } from "@rakazo/contracts";
import { Badge } from "@rakazo/ui-web";
import { Check, Clock3, GitBranch, Mail } from "lucide-react";
import { SandboxedHtmlViewer } from "../../components/SandboxedHtmlViewer";

/** The saved template flow, never a claim that any particular person received a step. */
export function CampaignObservedDetails({
  details,
  sender,
  stopOnReply,
  status,
}: {
  details?: RecruitingCampaignDetails;
  sender?: string | null;
  stopOnReply?: boolean | null;
  status?: number | null;
}) {
  const { t } = useLingui();
  return (
    <section aria-label={t`Saved email flow`} className="min-w-0 space-y-5">
      {status === 3 ? (
        <div className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/5 p-4 text-sm">
          <Check size={18} className="mt-0.5 shrink-0 text-success" aria-hidden />
          <p>
            <Trans>Automatic outreach is complete. Late replies will still appear in Inbox.</Trans>
          </p>
        </div>
      ) : null}
      <details className="rounded-lg border bg-card p-4 text-sm">
        <summary className="cursor-pointer font-semibold">
          <Trans>Sending schedule</Trans>
        </summary>
        {details?.schedules == null ? (
          <p className="mt-3 text-muted-foreground">
            <Trans>Schedule unavailable.</Trans>
          </p>
        ) : details.schedules.length === 0 ? (
          <p className="mt-3 text-muted-foreground">
            <Trans>No schedules returned.</Trans>
          </p>
        ) : (
          <ol className="mt-3 space-y-3">
            {details.schedules.map((schedule, index) => (
              <li key={index}>
                {schedule ? (
                  <>
                    {schedule.name ? (
                      <strong className="block break-words">{schedule.name}</strong>
                    ) : null}
                    <p className="mt-1 break-words text-muted-foreground">
                      {schedule.from ?? "—"} – {schedule.to ?? "—"} · {schedule.timezone ?? "—"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      <Trans>Days unavailable.</Trans>
                    </p>
                  </>
                ) : (
                  <p>
                    <Trans>Schedule unavailable.</Trans>
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </details>
      <section aria-label={t`Email steps`} className="mx-auto max-w-3xl">
        <h3 className="mb-4 text-sm font-semibold">
          <Trans>Email steps</Trans>
        </h3>
        {details?.sequences == null ? (
          <p className="text-sm text-muted-foreground">
            <Trans>Email steps unavailable.</Trans>
          </p>
        ) : details.sequences.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <Trans>No sequences returned.</Trans>
          </p>
        ) : (
          <ol className="space-y-5">
            {details.sequences.map((sequence, index) => (
              <li key={index}>
                {sequence?.steps == null ? (
                  <p className="text-sm text-muted-foreground">
                    <Trans>Email steps unavailable.</Trans>
                  </p>
                ) : sequence.steps.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    <Trans>No steps returned.</Trans>
                  </p>
                ) : (
                  <ol className="space-y-4">
                    {sequence.steps.map((step, stepIndex) => (
                      <li
                        key={stepIndex}
                        className="relative min-w-0 ps-8 before:absolute before:bottom-0 before:start-3 before:top-0 before:border-s before:border-border last:before:bottom-6"
                      >
                        <span className="absolute start-0 top-0 z-10 flex size-6 items-center justify-center rounded-full border bg-background text-xs font-medium">
                          {stepIndex + 1}
                        </span>
                        {step?.type === "email" ? (
                          <>
                            <div className="mb-3 flex items-center gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                              <Clock3 size={13} aria-hidden />
                              {step.delay !== null && step.delayUnit === "days" ? (
                                <Trans>Delay: {step.delay} days</Trans>
                              ) : (
                                <Trans>Delay unavailable.</Trans>
                              )}
                            </div>
                            <article className="min-w-0 overflow-hidden rounded-xl border bg-card">
                              <header className="flex flex-wrap items-center justify-between gap-2 border-b p-4">
                                <h4 className="flex items-center gap-2 text-sm font-semibold">
                                  <Mail size={14} aria-hidden />
                                  {stepIndex === 0 ? (
                                    <Trans>Introduction email</Trans>
                                  ) : (
                                    <Trans>Follow-up {stepIndex}</Trans>
                                  )}
                                </h4>
                                <Badge variant="outline">
                                  <Trans>Saved template</Trans>
                                </Badge>
                              </header>
                              <div className="space-y-4 p-4">
                                <p className="break-words text-xs text-muted-foreground">
                                  <Trans>From</Trans> · {sender ?? t`Sender not reported`}
                                </p>
                                {step.variants == null ? (
                                  <p>
                                    <Trans>Email content unavailable.</Trans>
                                  </p>
                                ) : step.variants.length === 0 ? (
                                  <p>
                                    <Trans>No email variants returned.</Trans>
                                  </p>
                                ) : (
                                  <ul className="space-y-5">
                                    {step.variants.map((variant, variantIndex) => (
                                      <li key={variantIndex} className="min-w-0 space-y-2">
                                        <h5 className="break-words text-sm font-semibold">
                                          {variant?.subject ?? <Trans>Subject unavailable.</Trans>}
                                        </h5>
                                        {variant?.body == null ? (
                                          <p>
                                            <Trans>Email content unavailable.</Trans>
                                          </p>
                                        ) : /<[a-z][^>]*>/i.test(variant.body) ? (
                                          <>
                                            <div className="h-56 overflow-hidden rounded-md border">
                                              <SandboxedHtmlViewer
                                                html={variant.body}
                                                title={t`Saved email preview`}
                                              />
                                            </div>
                                            <details className="text-xs text-muted-foreground">
                                              <summary className="cursor-pointer">
                                                <Trans>Original email content</Trans>
                                              </summary>
                                              <pre className="mt-2 whitespace-pre-wrap break-words font-sans">
                                                {variant.body}
                                              </pre>
                                            </details>
                                          </>
                                        ) : (
                                          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                                            {variant.body}
                                          </p>
                                        )}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            </article>
                          </>
                        ) : (
                          <p className="rounded-lg border p-4 text-sm text-muted-foreground">
                            <Trans>Email step unavailable.</Trans>
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            ))}
          </ol>
        )}
        <div className="ms-3 mt-4 space-y-3 border-s border-dashed border-border ps-5 text-sm">
          <div className="flex items-start gap-2 rounded-lg bg-muted/30 p-3">
            <Clock3 size={15} className="mt-0.5 shrink-0" aria-hidden />
            <div>
              <h4 className="font-medium">
                <Trans>Reply handling</Trans>
              </h4>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {stopOnReply === true ? (
                  <Trans>Any reply stops remaining follow-ups.</Trans>
                ) : stopOnReply === false ? (
                  <Trans>Stop on reply is off. Follow-ups may continue after a reply.</Trans>
                ) : (
                  <Trans>Stop-on-reply behavior is not reported.</Trans>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2 px-3 text-xs text-muted-foreground">
            <GitBranch size={14} className="shrink-0" aria-hidden />
            <p>
              <Trans>
                If interested, review the reply and prepare the job posting in the conversation. No
                automatic next step is configured here.
              </Trans>
            </p>
          </div>
        </div>
      </section>
    </section>
  );
}
