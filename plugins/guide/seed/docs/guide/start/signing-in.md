---
title: Signing in
part: start
section: access
order: 1
audience: member
summary: Sign in with an emailed link or your work account, and pick the organisation you work in.
sources: [apps/web/src/ui/pages/Login.tsx, apps/web/src/ui/pages/SelectTenant.tsx, apps/web/src/api/auth/magic-link.ts]
verified: "0000000"
---

# Signing in

You sign in with your work email address. There is no password to remember: the app emails you a
one-time link, or sends you to your organisation's sign-in page when it uses one.

## How it works

1. You enter your email address on the **Sign in** screen.
2. The app emails you a sign-in link, or offers **Continue with** your work account when your
   organisation has connected one.
3. You open the link on the same device. It works once and expires after
   {{fact:magic_link.expiry_minutes}} minutes.
4. If you belong to more than one organisation, you choose which one to work in.

## Do it

1. Go to the app and enter your email address.
2. Choose **Email me a sign-in link**, or **Continue with** your work account if it is offered.
3. Open the email and click the link.
4. On **Choose an organisation**, pick the one you want. You can switch later from your account
   menu.

## Watch out for

- **"That sign-in link has expired."** Links last {{fact:magic_link.expiry_minutes}} minutes and
  work once. Request a new one from the same screen.
- **"Your organisation requires single sign-on for this email address."** Your organisation has
  turned off emailed links for your address. Use the **Continue with** button instead.
- **"This account has been blocked."** An administrator has removed your access. Contact them.
- **No email arrives.** Check your spam folder, and that you typed the address your organisation
  invited.
