import type { ComponentProps } from "react";
import { lazy, Suspense } from "react";
import type {
  CorrespondenceEmails as CorrespondenceEmailsComponent,
  RecruitingCorrespondence as RecruitingCorrespondenceComponent,
} from "../RecruitingCorrespondence";
import type { ContactsTab as ContactsTabComponent } from "./ContactsTab";
import type { InterviewTab as InterviewTabComponent } from "./InterviewTab";

// Views that are not on the first screen load when they are first opened.
const LoadedInterviewTab = lazy(() =>
  import("./InterviewTab").then((module) => ({ default: module.InterviewTab })),
);
const LoadedContactsTab = lazy(() =>
  import("./ContactsTab").then((module) => ({ default: module.ContactsTab })),
);

const LoadedRecruitingCorrespondence = lazy(() =>
  import("../RecruitingCorrespondence").then((module) => ({
    default: module.RecruitingCorrespondence,
  })),
);
const LoadedCorrespondenceEmails = lazy(() =>
  import("../RecruitingCorrespondence").then((module) => ({
    default: module.CorrespondenceEmails,
  })),
);

export function RecruitingCorrespondence(
  props: ComponentProps<typeof RecruitingCorrespondenceComponent>,
) {
  return (
    <Suspense fallback={null}>
      <LoadedRecruitingCorrespondence {...props} />
    </Suspense>
  );
}

export function CorrespondenceEmails(props: ComponentProps<typeof CorrespondenceEmailsComponent>) {
  return (
    <Suspense fallback={null}>
      <LoadedCorrespondenceEmails {...props} />
    </Suspense>
  );
}

export function InterviewTab(props: ComponentProps<typeof InterviewTabComponent>) {
  return (
    <Suspense fallback={null}>
      <LoadedInterviewTab {...props} />
    </Suspense>
  );
}

export function ContactsTab(props: ComponentProps<typeof ContactsTabComponent>) {
  return (
    <Suspense fallback={null}>
      <LoadedContactsTab {...props} />
    </Suspense>
  );
}
