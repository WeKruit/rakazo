import { Trans } from "@lingui/react/macro";
import type { RecruitingCampaignDetails } from "@rakazo/contracts";

export function CampaignObservedDetails({ details }: { details?: RecruitingCampaignDetails }) {
  return (
    <section className="space-y-4 rounded-lg border p-4 text-sm">
      <section>
        <h3 className="font-semibold">
          <Trans>Sending schedule</Trans>
        </h3>
        {details?.schedules == null ? (
          <p>
            <Trans>Schedule unavailable.</Trans>
          </p>
        ) : details.schedules.length === 0 ? (
          <p>
            <Trans>No schedules returned.</Trans>
          </p>
        ) : (
          <ol className="space-y-3">
            {details.schedules.map((schedule, index) => (
              <li key={index}>
                {schedule ? (
                  <>
                    {schedule.name ? <strong className="block">{schedule.name}</strong> : null}
                    <p>
                      {schedule.from ?? "—"} – {schedule.to ?? "—"} · {schedule.timezone ?? "—"}
                    </p>
                    <p className="text-muted-foreground">
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
      </section>
      <section>
        <h3 className="font-semibold">
          <Trans>Email steps</Trans>
        </h3>
        {details?.sequences == null ? (
          <p>
            <Trans>Email steps unavailable.</Trans>
          </p>
        ) : details.sequences.length === 0 ? (
          <p>
            <Trans>No sequences returned.</Trans>
          </p>
        ) : (
          <ol className="list-decimal space-y-4 ps-5">
            {details.sequences.map((sequence, index) => (
              <li key={index}>
                {sequence?.steps == null ? (
                  <p>
                    <Trans>Email steps unavailable.</Trans>
                  </p>
                ) : sequence.steps.length === 0 ? (
                  <p>
                    <Trans>No steps returned.</Trans>
                  </p>
                ) : (
                  <ol className="list-decimal space-y-3 ps-5">
                    {sequence.steps.map((step, stepIndex) => (
                      <li key={stepIndex}>
                        {step?.type === "email" ? (
                          <>
                            <p>
                              {step.delay !== null && step.delayUnit === "days" ? (
                                <Trans>Delay: {step.delay} days</Trans>
                              ) : (
                                <Trans>Delay unavailable.</Trans>
                              )}
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
                              <ul className="space-y-3">
                                {step.variants.map((variant, variantIndex) => (
                                  <li key={variantIndex}>
                                    <strong>
                                      {variant?.subject ?? <Trans>Subject unavailable.</Trans>}
                                    </strong>
                                    <p className="whitespace-pre-wrap break-words">
                                      {variant?.body ?? <Trans>Email content unavailable.</Trans>}
                                    </p>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </>
                        ) : (
                          <p>
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
      </section>
    </section>
  );
}
