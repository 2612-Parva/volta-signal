-- Draft Mailchimp campaigns attached to each variant so reviewers can edit
-- in the Mailchimp UI without sending.

ALTER TABLE variants ADD COLUMN mailchimp_campaign_id TEXT;
ALTER TABLE variants ADD COLUMN mailchimp_web_id INTEGER;
ALTER TABLE variants ADD COLUMN mailchimp_edit_url TEXT;
