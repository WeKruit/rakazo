-- Leads whose source sequence was deleted keep their stats with no sequence.
ALTER TABLE "recruiting_crm_leads" ALTER COLUMN "crmCampaignId" DROP NOT NULL;
