// Synthetic proposed rich-profile display contract, not an observed Autumn payload.
export const rawEmployerDescription = "Original employment narrative: ".concat(
  "This supplied paragraph describes responsibilities across several employers without a documented record delimiter. ".repeat(
    10,
  ),
);
export const rawEducationDescription = "Original education narrative: ".concat(
  "This supplied paragraph includes qualifications and coursework; its source wording must remain available. ".repeat(
    8,
  ),
);
export const profileLogoUrl =
  "https://media.licdn.com/dms/image/synthetic-only/company-logo?e=123&v=beta";
export const richProfileRow = {
  current_company: "Example Labs",
  company_logo_url: profileLogoUrl,
  profile_image_url: "https://assets.example.test/profile-photo.svg",
  employerDescriptions: { value: rawEmployerDescription, source_id: "work" },
  experience: {
    value: [
      {
        title: "Senior Machine Learning Engineer",
        company_name: "Example Labs",
        company_url: "https://company.example.test",
        company_logo_url: profileLogoUrl,
        location: "Remote",
        start_date: "Aug 2025",
        end_date: null,
        is_current: true,
        description: "Builds synthetic model evaluation systems. ".repeat(15),
        source_id: "work",
      },
      {
        title: "Senior Research Data Scientist",
        company_name: "Sample Research",
        start_date: "Jun 2022",
        end_date: "Aug 2025",
        company_logo_url: "https://assets.example.test/broken-logo.svg",
        description: "Original second role description.",
        source_id: "work",
      },
      {
        title: "Applied Scientist II",
        company_name: "Placeholder Mobility",
        start_date: "Oct 2021",
        end_date: "Jun 2022",
        source_id: "work",
      },
      {
        title: "Research Scientist Intern",
        company_name: "Demo Systems",
        start_date: "Jun 2020",
        end_date: "Sep 2020",
        source_id: "work",
      },
      {
        title: "Research and Teaching Assistant",
        company_name: "Example University",
        start_date: "Sep 2017",
        end_date: "Sep 2021",
        source_id: "work",
      },
    ],
    source_id: "work",
  },
  education_background: { value: rawEducationDescription, source_id: "school" },
  education: {
    value: [
      {
        school_name: { value: "Example University", source_id: "school" },
        school_url: "https://school.example.test",
        school_logo_url: "https://assets.example.test/school-logo.svg",
        degree: "PhD",
        field_of_study: "Computer Science",
        start_date: "2017",
        end_date: "2021",
        description: "Original doctoral study description. ".repeat(12),
      },
      {
        school_name: "Example University",
        degree: "MS",
        field_of_study: "Computer Science",
        start_date: "2015",
        end_date: "2017",
        source_id: "school",
      },
      {
        school_name: "Sample College",
        degree: null,
        field_of_study: null,
        start_date: null,
        end_date: null,
        description: "Attendance reported; degree and dates not supplied.",
        source_id: "school",
      },
    ],
    source_id: "school",
  },
  _sources: {
    work: "https://evidence.example.test/employment",
    school: "https://evidence.example.test/education",
  },
};
