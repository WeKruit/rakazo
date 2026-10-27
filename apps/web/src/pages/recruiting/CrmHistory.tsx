import type { RecruitingCrmDataInput } from "@rakazo/contracts";
import { useEffect } from "react";
import { withFeatureMessages } from "../../lib/i18n";

type ImportantStatus = NonNullable<
  Extract<RecruitingCrmDataInput, { operation: "important" }>["status"]
>;

import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Button, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { Shimmer } from "../../components/ai/primitives";
import { lazyPanel } from "../../components/ErrorBoundary";
import type { useCrmWorkbenchModel } from "./CrmWorkbench";

const CorrespondenceEmails = lazyPanel(() =>
  withFeatureMessages(() => import("../RecruitingCorrespondence")).then(
    (m) => m.CorrespondenceEmails,
  ),
);
export function CrmHistory({ model }: { model: ReturnType<typeof useCrmWorkbenchModel> }) {
  const { t } = useLingui();
  useEffect(model.onHistoryMounted, [model.onHistoryMounted]);
  const {
    browse,
    agent,
    threadId,
    mailCursor,
    setMailCursor,
    key,
    page,
    currentMail,
    mailPage,
    nativeMail,
    inboxEmails,
    selectedInboxEmail,
    selectedNativeMail,
    nativeMailStatus,
    draftEmail,
    people,
    selectedPerson,
    importantView,
    workflowLabels,
    importantStatus,
    sectionScope,
    sectionOffset,
    section,
    important,
    campaigns,
    detailsOffset,
    currentDetails,
    details,
    contactRegion,
    contactHeadingId,

    selectedRole,
    roleJdUrl,
    initialDescription,
    selectContact,
    queryDraft,
    setQueryDraft,
    setQuery,
    offset,
    setOffset,
    setRefresh,
    setSelectedMail,
    read,
    setStatusSelection,
    setSectionPage,
    setDetailsPage,
  } = model;
  return (
    <>
      {agent ? (
        <h2 className="mt-8 mb-3 font-semibold">
          <Trans>Earlier history</Trans>
        </h2>
      ) : (
        <span className="hire-eyebrow">
          <Trans>Earlier history</Trans>
        </span>
      )}
      <div className="mb-5 flex flex-wrap gap-3">
        <Button variant="outline" onClick={() => setRefresh((value) => value + 1)}>
          <Trans>Refresh</Trans>
        </Button>
        {browse.onStartRecruiting ? (
          <Button
            disabled={!initialDescription || read?.loading || read?.failed}
            onClick={() => browse.onStartRecruiting?.(initialDescription)}
          >
            <Trans>Start recruiting</Trans>
          </Button>
        ) : null}
      </div>
      {read?.key !== key || read.loading ? (
        <p role="status" className="py-2 text-sm">
          <Shimmer>{t`Loading candidate records…`}</Shimmer>
        </p>
      ) : null}
      {read?.key === key && read.failed ? (
        <p role="alert">
          <Trans>Could not load candidate records. Try refreshing.</Trans>
        </p>
      ) : null}
      {page?.scope === "legacy_role_labels" && !importantView && browse.view !== "sequence" ? (
        <p className="mb-4 text-sm text-muted-foreground">
          <Trans>
            Historical records matched to this client and role. These are not new search results or
            a verified shortlist.
          </Trans>
        </p>
      ) : null}
      {importantView ? (
        <section className="space-y-4">
          <h2 className="font-semibold">
            {browse.view === "interview" ? t`Interview workflow` : t`Important`}
          </h2>
          <p className="text-sm text-muted-foreground">
            <Trans>Organization-wide candidate-role records.</Trans>
          </p>
          <NativeSelect
            aria-label={t`Workflow filter`}
            value={importantStatus}
            onChange={(event) => {
              setStatusSelection({
                view: browse.view,
                status: event.target.value as ImportantStatus | "",
              });
            }}
          >
            {browse.view !== "interview" ? (
              <NativeSelectOption value="">
                <Trans>All Important records</Trans>
              </NativeSelectOption>
            ) : null}
            {browse.view !== "interview" ? (
              <NativeSelectOption value="high_signal">
                <Trans>High signal</Trans>
              </NativeSelectOption>
            ) : null}
            {Object.entries(workflowLabels)
              .filter(
                ([status]) =>
                  browse.view !== "interview" ||
                  ["needs_scheduling", "scheduled", "awaiting_feedback"].includes(status),
              )
              .map(([status, label]) => (
                <NativeSelectOption key={status} value={status}>
                  {label}
                </NativeSelectOption>
              ))}
          </NativeSelect>
          {!section || section.loading ? (
            <p role="status">
              <Trans>Loading candidate records…</Trans>
            </p>
          ) : null}
          {section?.failed ? (
            <p role="alert">
              <Trans>Could not load candidate records. Try refreshing.</Trans>
            </p>
          ) : null}
          {important ? (
            <>
              <p>
                <Plural
                  value={important.total}
                  _1="# candidate-role record"
                  other="# candidate-role records"
                />
              </p>
              <div className="hire-table-wrap overflow-x-auto">
                <table className="hire-table w-full text-left text-sm">
                  <thead>
                    <tr>
                      {[
                        t`Candidate`,
                        t`Client`,
                        t`Role`,
                        t`High signal`,
                        t`Workflow status`,
                        t`Updated`,
                        t`Messages`,
                      ].map((label) => (
                        <th key={label} scope="col">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {important.items.map((person) => (
                      <tr key={JSON.stringify([person.candidateId, person.roleKey])}>
                        <th scope="row">{person.name}</th>
                        <td>{person.clientLabel}</td>
                        <td>{person.roleLabel}</td>
                        <td>{person.highSignal ? t`High signal` : "—"}</td>
                        <td>
                          {person.workflowStatus ? workflowLabels[person.workflowStatus] : "—"}
                        </td>
                        <td>
                          {new Date(person.statusChangedAt ?? person.updatedAt).toLocaleString()}
                        </td>
                        <td>
                          <Button
                            variant="link"
                            onClick={() => selectContact(person.candidateId, undefined, person)}
                          >
                            <Trans>View messages</Trans>
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!important.items.length ? (
                <p>
                  <Trans>No Important records matched this filter.</Trans>
                </p>
              ) : null}
            </>
          ) : null}
          <div className="flex gap-2">
            {sectionOffset > 0 ? (
              <Button
                variant="outline"
                onClick={() =>
                  setSectionPage({ key: sectionScope, offset: Math.max(0, sectionOffset - 30) })
                }
              >
                <Trans>Previous</Trans>
              </Button>
            ) : null}
            {important?.nextOffset != null ? (
              <Button
                variant="outline"
                onClick={() => setSectionPage({ key: sectionScope, offset: important.nextOffset! })}
              >
                <Trans>Next</Trans>
              </Button>
            ) : null}
          </div>
          {browse.view === "interview" ? (
            <p className="text-sm text-muted-foreground">
              <Trans>
                Calendar booking details are not included in these manual CRM workflow records.
              </Trans>
            </p>
          ) : null}
        </section>
      ) : browse.view === "brief" ? (
        <section className="space-y-4">
          {selectedRole &&
          ![selectedRole.summary, selectedRole.description, selectedRole.jdText, roleJdUrl].some(
            (value) => value?.trim(),
          ) ? (
            <p>
              <Trans>
                No job description is saved for this role. Add a JD or link when starting
                recruiting.
              </Trans>
            </p>
          ) : null}
          {page?.selectedRole?.summary ? <p>{page.selectedRole.summary}</p> : null}
          {page?.selectedRole?.description ? (
            <p className="whitespace-pre-wrap">{page.selectedRole.description}</p>
          ) : null}
          {page?.selectedRole?.jdText ? (
            <p className="whitespace-pre-wrap">{page.selectedRole.jdText}</p>
          ) : null}
          {roleJdUrl ? (
            <a className="underline" href={roleJdUrl} target="_blank" rel="noreferrer">
              <Trans>Original job description</Trans>
            </a>
          ) : null}
        </section>
      ) : (
        <>
          {browse.view === "sequence" ? (
            <section className="mb-6 space-y-4">
              <h2 className="font-semibold">
                <Trans>Role campaigns</Trans>
              </h2>
              {!browse.selection.crmRoleId ? (
                <p>
                  <Trans>Choose a role to see its outreach.</Trans>
                </p>
              ) : !section || section.loading ? (
                <p role="status">
                  <Trans>Loading candidate records…</Trans>
                </p>
              ) : null}
              {section?.failed ? (
                <p role="alert">
                  <Trans>Could not load candidate records. Try refreshing.</Trans>
                </p>
              ) : null}
              {campaigns ? (
                <>
                  <div className="hire-table-wrap overflow-x-auto">
                    <table className="hire-table w-full text-left text-sm">
                      <thead>
                        <tr>
                          {[t`Campaign`, t`Provider status code`, t`Last synced`].map((label) => (
                            <th scope="col" key={label}>
                              {label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {campaigns.items.map((campaign) => (
                          <tr key={campaign.id}>
                            <th scope="row">{campaign.name}</th>
                            <td>{campaign.status ?? "—"}</td>
                            <td>{new Date(campaign.syncedAt).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!campaigns.items.length ? (
                    <p>
                      <Trans>No stored campaign associations were returned for this role.</Trans>
                    </p>
                  ) : null}
                  <div className="flex gap-2">
                    {sectionOffset > 0 ? (
                      <Button
                        variant="outline"
                        onClick={() =>
                          setSectionPage({
                            key: sectionScope,
                            offset: Math.max(0, sectionOffset - 30),
                          })
                        }
                      >
                        <Trans>Previous campaigns</Trans>
                      </Button>
                    ) : null}
                    {campaigns.nextOffset != null ? (
                      <Button
                        variant="outline"
                        onClick={() =>
                          setSectionPage({ key: sectionScope, offset: campaigns.nextOffset! })
                        }
                      >
                        <Trans>Next campaigns</Trans>
                      </Button>
                    ) : null}
                  </div>
                </>
              ) : null}
              <p className="text-sm text-muted-foreground">
                <Trans>
                  Sequence steps and delivery status are not included in these stored campaign
                  associations.
                </Trans>
              </p>
            </section>
          ) : null}
          <form
            className="mb-4 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setOffset(0);
              setQuery(queryDraft.trim());
            }}
          >
            <Input
              aria-label={t`Search contacts`}
              value={queryDraft}
              onChange={(event) => setQueryDraft(event.target.value)}
            />
            <Button type="submit" variant="outline">
              <Trans>Search</Trans>
            </Button>
          </form>
          {page ? (
            <p className="mb-3 text-sm">
              <Plural value={page.total} _1="# contact" other="# contacts" />
            </p>
          ) : null}
          {page ? (
            <div className="hire-table-wrap overflow-x-auto">
              <table className="hire-table w-full text-left text-sm">
                <thead>
                  <tr>
                    {[
                      t`Candidate`,
                      t`Current role`,
                      t`Email`,
                      t`Phone`,
                      t`Stage`,
                      t`Contact status`,
                      t`Outreach status`,
                      browse.view === "feedback" || browse.view === "sequence"
                        ? t`Details`
                        : t`Messages`,
                    ].map((label) => (
                      <th key={label} scope="col">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {people.map((person) => (
                    <tr key={person.candidateId}>
                      <th scope="row">
                        {person.name}
                        {person.linkedinUrl && /^https?:\/\//i.test(person.linkedinUrl) ? (
                          <a
                            className="block text-xs underline"
                            href={person.linkedinUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <Trans>LinkedIn</Trans>
                          </a>
                        ) : null}
                      </th>
                      <td>
                        {person.title ?? "—"}
                        {person.location ? (
                          <small className="block">{person.location}</small>
                        ) : null}
                      </td>
                      <td>{person.email ?? "—"}</td>
                      <td>{person.phone ?? "—"}</td>
                      <td>{person.stage ?? "—"}</td>
                      <td>{person.contactStatus || "—"}</td>
                      <td>{person.outreachStatus || "—"}</td>
                      <td>
                        <Button
                          variant="link"
                          onClick={() =>
                            browse.view === "feedback" || browse.view === "sequence"
                              ? selectContact(person.candidateId, browse.view)
                              : selectContact(person.candidateId, undefined, person)
                          }
                        >
                          {browse.view === "feedback" || browse.view === "sequence" ? (
                            <Trans>View details</Trans>
                          ) : (
                            <Trans>View messages</Trans>
                          )}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {page && !people.length ? (
            <p>
              <Trans>No records matched this search.</Trans>
            </p>
          ) : null}
          <div className="my-4 flex gap-2">
            {offset > 0 ? (
              <Button variant="outline" onClick={() => setOffset(Math.max(0, offset - 30))}>
                <Trans>Previous</Trans>
              </Button>
            ) : null}
            {page?.nextOffset !== null && page?.nextOffset !== undefined ? (
              <Button variant="outline" onClick={() => setOffset(page.nextOffset!)}>
                <Trans>Next</Trans>
              </Button>
            ) : null}
          </div>
          {browse.view === "feedback" || browse.view === "sequence" ? (
            <section
              ref={contactRegion}
              aria-labelledby={contactHeadingId}
              tabIndex={-1}
              className="my-6 space-y-4"
            >
              <h2 id={contactHeadingId} className="font-semibold">
                {selectedPerson?.name ?? details?.review?.candidateName ?? t`Candidate details`}
              </h2>
              {!browse.candidateId ? (
                <p>
                  <Trans>Select a contact to read their stored details.</Trans>
                </p>
              ) : !currentDetails || currentDetails.loading ? (
                <p role="status">
                  <Trans>Loading candidate records…</Trans>
                </p>
              ) : null}
              {currentDetails?.failed ? (
                <p role="alert">
                  <Trans>Could not load candidate records. Try refreshing.</Trans>
                </p>
              ) : null}
              {details && browse.view === "feedback" ? (
                <>
                  <h3 className="font-semibold">
                    <Trans>Role interest</Trans>
                  </h3>
                  {details.roleInterests.length ? (
                    <div className="hire-table-wrap overflow-x-auto">
                      <table className="hire-table w-full text-left text-sm">
                        <thead>
                          <tr>
                            {[t`Client`, t`Role`, t`Interest`, t`Source`].map((label) => (
                              <th scope="col" key={label}>
                                {label}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {details.roleInterests.map((interest) => (
                            <tr key={interest.roleKey}>
                              <th scope="row">{interest.clientLabel}</th>
                              <td>{interest.roleLabel}</td>
                              <td>
                                {interest.interest === "interested"
                                  ? t`Interested`
                                  : interest.interest === "declined"
                                    ? t`Declined`
                                    : t`Unknown`}
                              </td>
                              <td>
                                {interest.source === "manual"
                                  ? t`Human-entered`
                                  : interest.source === "ai"
                                    ? t`AI interpretation`
                                    : interest.source === "instantly"
                                      ? t`Email reply`
                                      : t`Unknown`}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p>
                      <Trans>No stored role-interest records were returned.</Trans>
                    </p>
                  )}
                  <h3 className="font-semibold">
                    <Trans>Internal review</Trans>
                  </h3>
                  {details.review ? (
                    <div className="space-y-2">
                      {details.review.roleTitle ? <p>{details.review.roleTitle}</p> : null}
                      <p>
                        {details.review.stage ?? "—"} ·{" "}
                        {details.review.reviewed === true
                          ? t`Reviewed`
                          : details.review.reviewed === false
                            ? t`Not reviewed`
                            : t`Review status unknown`}
                      </p>
                      {details.review.result ? (
                        <p>
                          {details.review.result === "approved"
                            ? t`Approved in internal review`
                            : details.review.result === "rejected"
                              ? t`Rejected in internal review`
                              : t`Pooled in internal review`}
                        </p>
                      ) : null}
                      {details.review.notes ? (
                        <p className="whitespace-pre-wrap">{details.review.notes}</p>
                      ) : null}
                    </div>
                  ) : (
                    <p>
                      <Trans>No internal review was returned.</Trans>
                    </p>
                  )}
                </>
              ) : null}
              {details && browse.view === "sequence" ? (
                <>
                  <h3 className="font-semibold">
                    <Trans>Contact campaign associations</Trans>
                  </h3>
                  {details.campaignAssociations.pipelineCampaign ? (
                    <p>
                      {details.campaignAssociations.pipelineCampaign.name} ·{" "}
                      <Trans>Primary pipeline campaign</Trans>
                    </p>
                  ) : null}
                  {details.campaignAssociations.leadCampaigns.map((association) => (
                    <p key={association.leadId}>
                      {association.campaign?.name ?? t`Campaign details unavailable`}
                      {association.campaign ? (
                        <>
                          {" "}
                          · <Trans>Provider status code</Trans>:{" "}
                          {association.campaign.status ?? "—"}
                        </>
                      ) : null}
                    </p>
                  ))}
                  {!details.campaignAssociations.pipelineCampaign &&
                  !details.campaignAssociations.leadCampaigns.length ? (
                    <p>
                      <Trans>No contact campaign associations were returned.</Trans>
                    </p>
                  ) : null}
                  <div className="flex gap-2">
                    {detailsOffset > 0 ? (
                      <Button
                        variant="outline"
                        onClick={() =>
                          setDetailsPage({
                            candidateId: details.candidateId,
                            offset: Math.max(0, detailsOffset - 30),
                          })
                        }
                      >
                        <Trans>Previous contact campaigns</Trans>
                      </Button>
                    ) : null}
                    {details.campaignAssociations.nextOffset != null ? (
                      <Button
                        variant="outline"
                        onClick={() =>
                          setDetailsPage({
                            candidateId: details.candidateId,
                            offset: details.campaignAssociations.nextOffset!,
                          })
                        }
                      >
                        <Trans>Next contact campaigns</Trans>
                      </Button>
                    ) : null}
                  </div>
                </>
              ) : null}
              <CrmOutbox model={model} />
            </section>
          ) : null}
          {browse.view === "inbox" ? (
            <section ref={contactRegion} aria-labelledby={contactHeadingId} tabIndex={-1}>
              <h2 id={contactHeadingId} className="mb-3 font-semibold">
                {selectedPerson?.name ?? t`Candidate messages`}
              </h2>
              {browse.onDraftReply && draftEmail && browse.candidateId ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    const person =
                      read?.key === key && !read.loading && !read.failed
                        ? selectedPerson
                        : undefined;
                    browse.onDraftReply?.({
                      threadId,
                      candidateId: browse.candidateId!,
                      ...(person
                        ? { candidateName: person.name, candidateEmail: person.email }
                        : {}),
                      email: {
                        sender: draftEmail.sender,
                        recipients: draftEmail.recipients,
                        subject: draftEmail.subject,
                        date: draftEmail.date,
                      },
                      source: {
                        serverId: browse.selection.serverId,
                        serverRevision: browse.selection.serverRevision,
                        organizationId: browse.selection.organizationId,
                      },
                      ...(browse.selection.crmRoleId
                        ? { crmRoleId: browse.selection.crmRoleId }
                        : {}),
                    });
                  }}
                >
                  <Trans>Draft reply</Trans>
                </Button>
              ) : null}
              {!browse.candidateId ? (
                <p>
                  <Trans>Select a contact to read their stored messages.</Trans>
                </p>
              ) : !currentMail || (!currentMail.data && !currentMail.failed) ? (
                <p role="status">
                  <Trans>Loading stored messages…</Trans>
                </p>
              ) : currentMail.failed ? (
                <p role="alert">
                  <Trans>Could not load stored messages. Try refreshing.</Trans>
                </p>
              ) : mailPage ? (
                <>
                  {inboxEmails.length ? (
                    <>
                      <p className="my-3 text-sm text-muted-foreground">
                        {selectedNativeMail?.email?.sourceName ?? mailPage.source.name}
                        {selectedNativeMail ? (
                          <> · {nativeMailStatus[selectedNativeMail.status]}</>
                        ) : null}
                      </p>
                      <CorrespondenceEmails
                        emails={inboxEmails}
                        selectedId={selectedInboxEmail?.id}
                        onSelect={setSelectedMail}
                      />
                    </>
                  ) : (
                    <p>
                      <Trans>No stored messages were returned for this contact.</Trans>
                    </p>
                  )}
                  {nativeMail
                    .filter((entry) => entry.status === "unknown")
                    .map((entry) => (
                      <p key={entry.id} role="status" className="my-3 text-sm">
                        {nativeMailStatus.unknown} ·{" "}
                        <time dateTime={entry.checkedAt}>
                          {new Date(entry.checkedAt).toLocaleString()}
                        </time>
                      </p>
                    ))}
                  {mailCursor ? (
                    <Button variant="outline" onClick={() => setMailCursor(undefined)}>
                      <Trans>Latest messages</Trans>
                    </Button>
                  ) : null}
                  {mailPage.nextCursor ? (
                    <Button variant="outline" onClick={() => setMailCursor(mailPage.nextCursor!)}>
                      <Trans>Older messages</Trans>
                    </Button>
                  ) : null}
                </>
              ) : null}
              <CrmOutbox model={model} />
            </section>
          ) : null}
        </>
      )}
    </>
  );
}

function CrmOutbox({ model }: { model: ReturnType<typeof useCrmWorkbenchModel> }) {
  const { t } = useLingui();
  const { outbox, contactRead, showDiagnostics } = model;
  const queueStatusLabels = {
    pending: t`Saved, not sent`,
    processing: t`Previously processing`,
    sent: t`Marked as sent`,
    failed: t`Send failed`,
  };
  return outbox ? (
    <section className="my-6 space-y-3" aria-label={t`Recruiter messages`}>
      <h3 className="font-semibold">
        <Trans>Recruiter messages</Trans>
      </h3>
      {contactRead?.data &&
      "outboxScope" in contactRead.data &&
      contactRead.data.outboxScope === "unavailable_for_role" ? (
        <p>
          <Trans>Recruiter messages are unavailable for this role.</Trans>
        </p>
      ) : outbox.length ? (
        outbox.map((message) => (
          <article key={message.id} className="space-y-2 border-t pt-3">
            <p>
              {queueStatusLabels[message.status]} ·{" "}
              <time dateTime={message.createdAt}>
                {new Date(message.createdAt).toLocaleString()}
              </time>
            </p>
            <h4 className="font-semibold">
              <Trans>Original message</Trans>
            </h4>
            <p className="whitespace-pre-wrap">{message.body}</p>
            {message.polishedBody !== null ? (
              <>
                <h4 className="font-semibold">
                  <Trans>Polished message</Trans>
                </h4>
                <p className="whitespace-pre-wrap">{message.polishedBody}</p>
              </>
            ) : null}
            {message.error !== null ? (
              <>
                <p>
                  <Trans>There was a problem sending this message.</Trans>
                </p>
                {showDiagnostics ? (
                  <details>
                    <summary>
                      <Trans>Error details</Trans>
                    </summary>
                    <pre className="whitespace-pre-wrap">{message.error}</pre>
                  </details>
                ) : null}
              </>
            ) : null}
            {message.sentAt !== null ? (
              <p>
                <Trans>Sent at</Trans>:{" "}
                <time dateTime={message.sentAt}>{new Date(message.sentAt).toLocaleString()}</time>
              </p>
            ) : null}
          </article>
        ))
      ) : (
        <p>
          <Trans>No recruiter messages were found.</Trans>
        </p>
      )}
    </section>
  ) : null;
}
