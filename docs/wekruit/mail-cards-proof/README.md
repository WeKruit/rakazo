# Sender confirmation and editable replies

These screenshots use synthetic identities and mocked service responses in the actual app. They prove rendering and interaction at 1440×900 and 390×844, not hosted provisioning or mail delivery.

## Sender setup

The existing native question asks for the company name. The next native approval shows the exact proposed sending address and company, with **Use this address** and **Change the address**. Approval means **Address confirmed**, not that provisioning or warming has completed. There is no third confirmation card.

| State | Desktop | Mobile web |
| --- | --- | --- |
| Company | [1440](sender-company-1440.png) | [390](sender-company-390.png) |
| Address approval | [1440](sender-address-1440.png) | [390](sender-address-390.png) |
| Confirmed | [1440](sender-confirmed-1440.png) | [390](sender-confirmed-390.png) |

## Reply card

The conversation and Inbox read the same persisted approval message. Body and Cc edits go through its existing Send action; Discard denies that approval. From, To, subject and the original anchor remain fixed. The original-email link performs a scoped server read even when the original lies beyond the first 50 conversations or messages. Sent history uses the delivery receipt and actual edited content.

| State | Desktop | Mobile web |
| --- | --- | --- |
| Pending | [1440](mail-pending-1440.png) | [390](mail-pending-390.png) |
| Editing | [1440](mail-editing-1440.png) | [390](mail-editing-390.png) |
| Sent | [1440](mail-sent-1440.png) | [390](mail-sent-390.png) |
| Discarded | [1440](mail-discarded-1440.png) | [390](mail-discarded-390.png) |
| Inbox history | [1440](mail-inbox-history-1440.png) | [390](mail-inbox-history-390.png) |

Reproduce with the web Playwright specs `mail-reply-cards.spec.ts` and `sender-confirmation-cards.spec.ts`. Both are included in the existing recruiting CI screenshot job. Native mobile rendering uses the existing Ask lane; these images are mobile web, not a native-device acceptance claim.

## Release requirements

Choose an eligible domain already ordered in the connected sending service; do not purchase another domain. Show actual setup and warm-up states without estimated completion dates. The mailbox cap defaults to two through existing deployment settings.

The earlier recruiting UI dependency, #788, has merged into stage. Its profile migration is `20261101170000_recruiting_profile_projection_intent_index` (concurrent index outside a transaction); the sender change adds `20261101180000_recruiting_sender_mailbox_limit` (existing settings column). Check the migration ledger and apply only outstanding named changes once. No production migration is included in acceptance.

Hosted acceptance remains separate: verify the deployed revision, fresh-account setup, confirmed sender reuse across roles, cap enforcement, and edited reply delivery/discard/history through the test environment. Private mailbox addresses and screenshots must remain outside this public repository.
