import { Trans, useLingui } from "@lingui/react/macro";
import type {
  EditRecruitingCriteriaInput,
  RecruitingCriterionExpression,
  RecruitingEmploymentDay,
  RecruitingEmploymentRule,
} from "@rakazo/contracts";
import { RecruitingEmploymentDaySchema } from "@rakazo/contracts";
import { Input, NativeSelect, NativeSelectOption, Textarea } from "@rakazo/ui-web";
import { useId } from "react";

export function CriteriaExpression({ expression }: { expression: RecruitingCriterionExpression }) {
  if (expression.kind === "atom")
    return <p className="whitespace-pre-wrap">{expression.statement}</p>;
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        {expression.kind === "all" ? (
          <Trans>All of</Trans>
        ) : expression.kind === "any" ? (
          <Trans>Any of</Trans>
        ) : (
          <Trans>Must not</Trans>
        )}
      </p>
      <ul className="space-y-2 border-s border-border ps-3">
        {(expression.kind === "not" ? [expression.item] : expression.items).map((item, index) => (
          <li key={index}>
            <CriteriaExpression expression={item} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export {
  type CriteriaEdit,
  criteriaDraft,
  expressionAtoms,
  searchFilterDraft,
} from "./criteria-draft";

export function employmentDateValue(date: RecruitingEmploymentDay): string {
  return RecruitingEmploymentDaySchema.safeParse(date).success
    ? `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`
    : "";
}

export function EmploymentRuleSummary({ rule }: { rule: RecruitingEmploymentRule }) {
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>
        <Trans>Minimum {rule.minimumMonths} complete calendar months</Trans> ·{" "}
        {rule.qualificationDefinition}
      </p>
      <p>
        <Trans>Count through</Trans> ·{" "}
        {rule.cutoff.kind === "fixed" ? (
          employmentDateValue(rule.cutoff.date)
        ) : (
          <Trans>Assessment date</Trans>
        )}
      </p>
    </div>
  );
}

export function CriteriaExpressionFields({
  expression,
  atoms,
  onChange,
}: {
  expression: RecruitingCriterionExpression;
  atoms: EditRecruitingCriteriaInput["criteria"][number]["atoms"];
  onChange: (atom: EditRecruitingCriteriaInput["criteria"][number]["atoms"][number]) => void;
}) {
  const { t } = useLingui();
  const fieldId = useId();
  if (expression.kind === "atom") {
    const atom = atoms.find((atom) => atom.atomId === expression.id)!;
    if ("employmentRule" in atom) {
      const rule = atom.employmentRule;
      return (
        <fieldset className="space-y-2">
          <legend className="text-xs text-muted-foreground">
            <Trans>Employment rule</Trans>
          </legend>
          <label htmlFor={`${fieldId}-months`} className="block space-y-1">
            <span>
              <Trans>Minimum complete calendar months</Trans>
            </span>
            <Input
              id={`${fieldId}-months`}
              type="number"
              min={0}
              step={1}
              aria-invalid={!Number.isSafeInteger(rule.minimumMonths) || rule.minimumMonths < 0}
              aria-label={t`Minimum complete calendar months`}
              value={Number.isNaN(rule.minimumMonths) ? "" : rule.minimumMonths}
              onChange={(event) =>
                onChange({
                  ...atom,
                  employmentRule: { ...rule, minimumMonths: event.target.valueAsNumber },
                })
              }
            />
          </label>
          <label htmlFor={`${fieldId}-qualification`} className="block space-y-1">
            <span>
              <Trans>Qualifying work</Trans>
            </span>
            <Textarea
              id={`${fieldId}-qualification`}
              aria-label={t`Qualifying work`}
              value={rule.qualificationDefinition}
              aria-invalid={!rule.qualificationDefinition.trim()}
              onChange={(event) =>
                onChange({
                  ...atom,
                  employmentRule: { ...rule, qualificationDefinition: event.target.value },
                })
              }
            />
          </label>
          <label htmlFor={`${fieldId}-cutoff`} className="block space-y-1">
            <span>
              <Trans>Count through</Trans>
            </span>
            <NativeSelect
              id={`${fieldId}-cutoff`}
              aria-label={t`Count through`}
              value={rule.cutoff.kind}
              onChange={(event) =>
                onChange({
                  ...atom,
                  employmentRule: {
                    ...rule,
                    cutoff:
                      event.target.value === "assessment_date"
                        ? { kind: "assessment_date" }
                        : { kind: "fixed", date: { precision: "day", year: 0, month: 0, day: 0 } },
                  },
                })
              }
            >
              <NativeSelectOption value="assessment_date">
                <Trans>Assessment date</Trans>
              </NativeSelectOption>
              <NativeSelectOption value="fixed">
                <Trans>Fixed date</Trans>
              </NativeSelectOption>
            </NativeSelect>
          </label>
          {rule.cutoff.kind === "fixed" ? (
            <label htmlFor={`${fieldId}-date`} className="block space-y-1">
              <span>
                <Trans>Cutoff date</Trans>
              </span>
              <Input
                id={`${fieldId}-date`}
                type="date"
                aria-label={t`Cutoff date`}
                value={employmentDateValue(rule.cutoff.date)}
                aria-invalid={!employmentDateValue(rule.cutoff.date)}
                onChange={(event) => {
                  const [year = 0, month = 0, day = 0] = event.target.value.split("-").map(Number);
                  onChange({
                    ...atom,
                    employmentRule: {
                      ...rule,
                      cutoff: { kind: "fixed", date: { precision: "day", year, month, day } },
                    },
                  });
                }}
              />
            </label>
          ) : null}
        </fieldset>
      );
    }
    const statement = atom.statement;
    return (
      <Textarea
        aria-label={t`Statement`}
        value={statement}
        aria-invalid={!statement.trim()}
        onChange={(event) => onChange({ ...atom, statement: event.target.value })}
      />
    );
  }
  return (
    <fieldset className="space-y-2 border-s border-border ps-3">
      <legend className="text-xs text-muted-foreground">
        {expression.kind === "all" ? (
          <Trans>AND</Trans>
        ) : expression.kind === "any" ? (
          <Trans>OR</Trans>
        ) : (
          <Trans>NOT</Trans>
        )}
      </legend>
      {(expression.kind === "not" ? [expression.item] : expression.items).map((item, index) => (
        <CriteriaExpressionFields key={index} expression={item} atoms={atoms} onChange={onChange} />
      ))}
    </fieldset>
  );
}
