import type {
  EditRecruitingCriteriaInput,
  RecruitingCriterionExpression,
  RecruitingRoleRevision,
} from "@rakazo/contracts";

export function expressionAtoms(
  expression: RecruitingCriterionExpression,
): EditRecruitingCriteriaInput["criteria"][number]["atoms"] {
  if (expression.kind === "atom")
    return [
      expression.employmentRule
        ? { atomId: expression.id, employmentRule: expression.employmentRule }
        : { atomId: expression.id, statement: expression.statement },
    ];
  if (expression.kind === "not") return expressionAtoms(expression.item);
  return [
    ...new Map(
      expression.items.flatMap(expressionAtoms).map((atom) => [atom.atomId, atom]),
    ).values(),
  ];
}

export function criteriaDraft(
  revision: RecruitingRoleRevision,
): EditRecruitingCriteriaInput["criteria"] {
  return revision.criteria.map((criterion) => ({
    criterionId: criterion.id,
    priority: criterion.priority,
    atoms: expressionAtoms(criterion.expression),
  }));
}

export type CriteriaEdit = {
  roleId: string;
  revision: RecruitingRoleRevision;
  criteria: EditRecruitingCriteriaInput["criteria"];
  searchFilters: NonNullable<EditRecruitingCriteriaInput["searchFilters"]>;
};

export function searchFilterDraft(revision: RecruitingRoleRevision): CriteriaEdit["searchFilters"] {
  return (revision.brief?.searchFilters ?? []).map(({ id, statement, mode }) => ({
    id,
    statement,
    mode,
  }));
}
