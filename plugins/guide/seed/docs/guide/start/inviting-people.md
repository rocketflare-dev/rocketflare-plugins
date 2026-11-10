---
title: Inviting people
part: start
section: access
order: 2
audience: member
summary: How invitations work, how to accept one, and how to get a colleague added.
sources: [apps/web/src/ui/pages/InviteAccept.tsx, apps/web/src/api/services/invitations.ts]
verified: "0000000"
---

# Inviting people

People join an organisation by invitation. An admin sends one to an email address, and the person
accepts it by signing in with that address. If you need a colleague added, ask an admin of your
organisation.

## How it works

1. An admin invites an email address and chooses the role the person will have.
2. The person receives an email with a link to the invitation.
3. They open it, sign in with the invited address and choose **Accept**.
4. The invitation expires after {{fact:invitation.expiry_days}} days if nobody accepts it.

## Do it

To accept an invitation:

1. Open the link in the invitation email.
2. Sign in with the address the invitation was sent to.
3. On **You've been invited**, accept it. You land in the organisation straight away.

## Watch out for

- **"Invitation expired."** Ask the admin who invited you to send it again.
- **"Already accepted."** The invitation has been used. Sign in normally.
- **You signed in with a different address.** An invitation belongs to one email address. Sign out
  and sign in with the invited one.
