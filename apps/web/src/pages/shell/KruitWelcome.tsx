import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";

/** Kruit before the first message: what to send, and one example to start from. */
export function KruitWelcome({ onExample }: { onExample: (text: string) => void }) {
  const { t } = useLingui();
  const example = t`Client: a Series B fintech in New York. Role: Senior Backend Engineer, 6+ years, Go or Java, payments experience, onsite 3 days a week, base $200–240k.`;
  return (
    <div data-testid="kruit-welcome" className="grid flex-1 place-items-center px-6">
      <div className="max-w-[440px] text-center">
        <h2 className="text-xl font-medium tracking-tight">
          <Trans>Paste a job description to start</Trans>
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          <Trans>Kruit asks a few questions, then finds ten people for you to review.</Trans>
        </p>
        <Button variant="outline" size="sm" className="mt-5" onClick={() => onExample(example)}>
          <Trans>Use an example</Trans>
        </Button>
      </div>
    </div>
  );
}
