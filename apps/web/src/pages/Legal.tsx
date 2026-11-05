import { Trans } from "@lingui/react/macro";
import { Link } from "react-router-dom";
import { useSupportEmail } from "../lib/support";

type Section = { heading: string; body: string[] };

const UPDATED = "November 5, 2026";

const TERMS: Section[] = [
  {
    heading: "The service",
    body: [
      "WeKruit Headhunter helps recruiting teams find, review and contact candidates with AI assistants. By creating an account or using the service you agree to these terms.",
    ],
  },
  {
    heading: "Your account",
    body: [
      "You must give accurate sign-up information and keep your password private. You are responsible for activity under your account. Tell us right away if you think your account was accessed without permission.",
    ],
  },
  {
    heading: "Credits and payment",
    body: [
      "Searches, contact lookups and AI work use credits. New accounts receive starting credits. When credits run out, new work pauses until more credits are added. Credits have no cash value and are not refundable except where the law requires.",
    ],
  },
  {
    heading: "Acceptable use",
    body: [
      "Use the service only for lawful recruiting. You are responsible for having a lawful basis to contact candidates, for honoring opt-out requests, and for following anti-spam, employment and privacy laws that apply to you. Do not use the service to harass people, send bulk unsolicited messages, scrape or resell data, or interfere with the service.",
      "Nothing is sent to a candidate or put on a calendar without your approval.",
    ],
  },
  {
    heading: "Connected accounts",
    body: [
      "If you connect Gmail or a calendar, you let the service read and act on that account as described when you connect it. You can disconnect at any time in Integrations.",
    ],
  },
  {
    heading: "Your content",
    body: [
      "You keep ownership of the job descriptions, notes, messages and other material you add. You let us process it only to provide the service to you. AI output can be wrong; review results before relying on them.",
    ],
  },
  {
    heading: "Ending your account",
    body: [
      "You can delete your account in Settings. We may suspend accounts that break these terms or put the service or other people at risk.",
    ],
  },
  {
    heading: "Disclaimers and liability",
    body: [
      'The service is provided "as is". To the extent the law allows, we are not liable for indirect or consequential losses, and our total liability is limited to the amount you paid us in the 12 months before the claim.',
    ],
  },
  {
    heading: "Changes",
    body: [
      "We may update these terms. If a change is material we will tell you before it takes effect. Continuing to use the service means you accept the updated terms.",
    ],
  },
];

const PRIVACY: Section[] = [
  {
    heading: "What we collect",
    body: [
      "Account details: your name, email address and sign-in information.",
      "Work you do in the service: roles, job descriptions, notes, messages, feedback and files you add.",
      "Candidate information: public professional profiles and contact details found for your searches, plus anything you add about candidates.",
      "Connected accounts: if you connect Gmail or a calendar, the messages and events the service needs for the task you asked for.",
      "Usage records: credits used, errors and basic device information, used to run and improve the service.",
    ],
  },
  {
    heading: "How we use it",
    body: [
      "To provide the service you asked for, keep it secure, show your usage and contact you about your account. We do not sell personal information and we do not use your private content to advertise to you.",
    ],
  },
  {
    heading: "Who processes it",
    body: [
      "We use service providers for hosting, AI models, email delivery and candidate research. They process data only on our instructions and only to provide the service.",
    ],
  },
  {
    heading: "Google user data",
    body: [
      "Data from Gmail or Google Calendar is used only to provide features you use in WeKruit Headhunter, is not used for advertising, is not sold, and is not used to train general AI models. People can read it only with your permission, for security, or where the law requires.",
    ],
  },
  {
    heading: "Your account is private",
    body: [
      "Your roles, candidates, conversations and connected accounts are visible only to you unless you share them.",
    ],
  },
  {
    heading: "Retention and deletion",
    body: [
      "We keep your data while your account is open. When you delete your account in Settings, your account and its data are deleted. You can export your candidates from the Candidates page at any time.",
    ],
  },
  {
    heading: "Candidates",
    body: [
      "If you are a candidate and want to know what we hold about you, or want it removed, email us and we will help.",
    ],
  },
  {
    heading: "Changes",
    body: ["If we change this policy in a material way, we will tell account holders first."],
  },
];

export function LegalPage({ kind }: { kind: "terms" | "privacy" }) {
  const sections = kind === "terms" ? TERMS : PRIVACY;
  const email = useSupportEmail();
  return (
    <div className="h-full overflow-y-auto bg-background text-foreground">
      <article className="mx-auto max-w-[680px] px-4 py-12">
        <Link to="/" className="text-sm text-muted-foreground">
          WeKruit Headhunter
        </Link>
        <h1 className="mt-6 text-3xl font-medium tracking-tight">
          {kind === "terms" ? <Trans>Terms of Service</Trans> : <Trans>Privacy Policy</Trans>}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          <Trans>Updated {UPDATED}</Trans>
        </p>
        {sections.map((section) => (
          <section key={section.heading} className="mt-8">
            <h2 className="text-lg font-medium">{section.heading}</h2>
            {section.body.map((paragraph) => (
              <p key={paragraph} className="mt-3 leading-7 text-foreground/80">
                {paragraph}
              </p>
            ))}
          </section>
        ))}
        {email ? (
          <p className="mt-10 leading-7 text-foreground/80">
            <Trans>
              Questions: <a href={`mailto:${email}`}>{email}</a>
            </Trans>
          </p>
        ) : null}
      </article>
    </div>
  );
}

/** One line under the sign-up button; creating the account is the agreement. */
export function LegalNotice() {
  return (
    <p className="mt-4 text-center text-sm text-muted-foreground">
      <Trans>
        By creating an account you agree to the{" "}
        <Link to="/terms" className="underline">
          Terms
        </Link>{" "}
        and{" "}
        <Link to="/privacy" className="underline">
          Privacy Policy
        </Link>
        .
      </Trans>
    </p>
  );
}
