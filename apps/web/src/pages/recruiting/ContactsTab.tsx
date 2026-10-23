import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingCorrespondence } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";
import { useRecruitingDetail } from "./detail";
import type { RecruitingTabProps } from "./shared";
import {
  CrmGate,
  formatDate,
  statusText,
  TabHeader,
  TabLoading,
  TabNotice,
  useCrmData,
  useRoleCrm,
  useSavedCorrespondence,
} from "./shared";

type SavedContact = RecruitingCorrespondence["contacts"][number];

/** Profile identity for joining saved lookups to CRM rows; never used to merge people. */
export function linkedinKey(url: string | null | undefined) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return null;
  }
}

function SavedEmails({ lookups }: { lookups: readonly SavedContact[] }) {
  const emails = lookups.flatMap((lookup) => lookup.emails);
  if (!emails.length) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
      {emails.map((email, index) => (
        <li key={`${email.address}:${index}`}>
          {email.address} · {statusText(email.status)}
        </li>
      ))}
    </ul>
  );
}

const PAGE = 50;

/** The role's CRM contacts with pipeline stage, contact fields and email status. */
export function ContactsTab(props: RecruitingTabProps) {
  const { t } = useLingui();
  const detail = useRecruitingDetail();
  const crm = useRoleCrm(props);
  const [offset, setOffset] = useState(0);
  const people = useCrmData(
    crm,
    "candidates",
    crm.status === "ready" ? { crmRoleId: crm.target.crmRoleId, limit: PAGE, offset } : null,
    props,
  );
  const saved = useSavedCorrespondence(props, "contacts");
  const lookups = new Map<string, SavedContact[]>();
  for (const contact of saved.data?.contacts ?? []) {
    const key = linkedinKey(contact.linkedinUrl);
    if (key) lookups.set(key, [...(lookups.get(key) ?? []), contact]);
  }
  const page = people.data;
  const unmatched = (saved.data?.contacts ?? []).filter(
    (contact) =>
      !page?.items.some(
        (person) => linkedinKey(person.linkedinUrl) === linkedinKey(contact.linkedinUrl),
      ),
  );
  return (
    <section aria-label={t`Contacts`}>
      <TabHeader title={<Trans>Contacts</Trans>}>
        {page ? <span className="text-sm text-muted-foreground">{page.total}</span> : null}
      </TabHeader>
      <CrmGate crm={crm} />
      {people.loading ? <TabLoading /> : null}
      {people.failed ? (
        <TabNotice alert>
          <Trans>Could not load CRM records. Try refreshing.</Trans>
        </TabNotice>
      ) : null}
      {page && !page.items.length ? (
        <TabNotice>
          <Trans>No CRM contacts for this role yet.</Trans>
        </TabNotice>
      ) : null}
      {page?.items.length ? (
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
                ].map((label) => (
                  <th scope="col" key={label}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page.items.map((person) => {
                const key = linkedinKey(person.linkedinUrl);
                return (
                  <tr key={person.candidateId}>
                    <th scope="row">
                      {detail ? (
                        <Button
                          variant="link"
                          className="h-auto p-0"
                          onClick={() =>
                            detail.open({
                              view: "contact",
                              person,
                              role: {
                                roleId: props.roleId,
                                spaceId: props.spaceId,
                                conversation: props.conversation,
                              },
                            })
                          }
                        >
                          {person.name}
                        </Button>
                      ) : (
                        person.name
                      )}
                      {key && person.linkedinUrl ? (
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
                      {person.location ? <small className="block">{person.location}</small> : null}
                    </td>
                    <td>
                      {person.email ?? "—"}
                      <SavedEmails lookups={(key && lookups.get(key)) || []} />
                    </td>
                    <td>{person.phone ?? "—"}</td>
                    <td>{statusText(person.stage)}</td>
                    <td>{statusText(person.contactStatus)}</td>
                    <td>{statusText(person.outreachStatus)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {page && (offset > 0 || page.nextOffset !== null) ? (
        <div className="mt-3 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
          >
            <Trans>Previous</Trans>
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page.nextOffset === null}
            onClick={() => page.nextOffset !== null && setOffset(page.nextOffset)}
          >
            <Trans>Next</Trans>
          </Button>
        </div>
      ) : null}
      {unmatched.length ? (
        <section className="mt-6" aria-label={t`Saved contact lookups`}>
          <h3 className="mb-2 text-sm font-semibold">
            <Trans>Saved contact lookups</Trans>
          </h3>
          <ul className="space-y-2 text-sm">
            {unmatched.map((contact, index) => (
              <li
                key={`${contact.candidateKey}:${index}`}
                className="rounded-lg border border-border p-3"
              >
                <a
                  href={contact.linkedinUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  <Trans>LinkedIn</Trans>
                </a>
                <SavedEmails lookups={[contact]} />
                {contact.phones.length ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {contact.phones.map((phone) => phone.number).join(", ")}
                  </p>
                ) : null}
                <p className="mt-1 text-xs text-muted-foreground">
                  {contact.source} · {formatDate(contact.checkedAt)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
