import { Metadata } from 'next';
import { GlassCard } from '@gitroom/frontend/components/ui/glass-card';
import {
  SITE_URL,
  SITE_DOMAIN,
  CONTACT_EMAIL,
} from '@gitroom/frontend/lib/site';

export const dynamic = 'force-static';
export const revalidate = false;

export const metadata: Metadata = {
  title: 'Terms of Service — D3 Creator',
  description:
    'D3 Creator Terms of Service: the rules and conditions for using our social media analytics platform.',
  alternates: { canonical: '/terms' },
};

const sectionTitle = 'text-section mt-12 mb-4 text-fg';
const subTitle = 'text-subsection mt-8 mb-3 text-fg';
const paragraph = 'text-body text-fgMuted mb-4';
const bullet = 'text-body text-fgMuted mb-2';
const linkClass =
  'text-brand hover:text-brand-light transition-colors underline underline-offset-4 decoration-brand/40 hover:decoration-brand-light/60';
const inlineStrong = 'text-fg font-semibold';

export default function TermsPage() {
  return (
    <article className="max-w-[720px] mx-auto pt-12 pb-24">
      <header className="mb-12 pb-8 border-b border-borderGlass">
        <span className="inline-flex items-center px-2.5 py-1 rounded-full glass-subtle border border-borderGlass text-caption text-fgMuted mb-6">
          Legal
        </span>
        <h1 className="text-display-2 text-fg mb-4">Terms of Service</h1>
        <p className="text-caption text-fgSubtle">
          Effective Date: 1 January 2025 · Last Updated: 29 June 2026
        </p>
      </header>

      <p className={paragraph}>
        These Terms of Service (&ldquo;
        <span className={inlineStrong}>Terms</span>&rdquo;) form a binding
        agreement between you (&ldquo;you&rdquo; or &ldquo;User&rdquo;) and{' '}
        <span className={inlineStrong}>D3 Creator</span> (&ldquo;D3
        Creator&rdquo;, &ldquo;we&rdquo;, &ldquo;our&rdquo;, or
        &ldquo;us&rdquo;) governing your access to and use of the D3 Creator
        website at{' '}
        <a className={linkClass} href={SITE_URL}>
          {SITE_DOMAIN}
        </a>{' '}
        and our related social media analytics services (collectively, the
        &ldquo;Service&rdquo;).
      </p>
      <p className={paragraph}>
        Please read these Terms carefully. By creating an account, accessing, or
        using the Service, you confirm that you have read, understood, and agree
        to be bound by these Terms and by our{' '}
        <a className={linkClass} href="/privacy">
          Privacy Policy
        </a>
        . If you do not agree, you must not use the Service.
      </p>

      <h2 className={sectionTitle}>1. Acceptance of Terms</h2>
      <p className={paragraph}>
        By accessing or using the Service, you represent that:
      </p>
      <ul className="list-disc pl-6 mb-3">
        <li className={bullet}>
          You are at least 16 years old, or have reached the age of majority in
          your jurisdiction, whichever is higher.
        </li>
        <li className={bullet}>
          You have the legal capacity to enter into a binding agreement.
        </li>
        <li className={bullet}>
          If you are using the Service on behalf of an organization, you have
          the authority to bind that organization to these Terms.
        </li>
        <li className={bullet}>
          Your use of the Service complies with all applicable laws and
          regulations.
        </li>
      </ul>

      <h2 className={sectionTitle}>2. Description of the Service</h2>
      <p className={paragraph}>
        D3 Creator is an agency-managed social media analytics platform.
        Agencies provision creator accounts and add the public social profiles
        they manage; creators sign in to view combined analytics across those
        profiles in a single dashboard. The Service currently supports analytics
        for Instagram, Facebook, TikTok, and Douyin. Public self-signup is not
        available — accounts are created by your agency. We may add or remove
        supported platforms from time to time.
      </p>

      <h2 className={sectionTitle}>3. User Accounts and Registration</h2>
      <h3 className={subTitle}>3.1 Account Creation</h3>
      <p className={paragraph}>
        Accounts are provisioned by your agency; public self-registration is not
        available. You agree to keep your account credentials secure and your
        contact information accurate and up to date.
      </p>
      <h3 className={subTitle}>3.2 Account Security</h3>
      <p className={paragraph}>
        You are responsible for safeguarding your password and for all activity
        that occurs under your account. You agree to notify us immediately of
        any unauthorized access or suspected security breach. We are not liable
        for any loss or damage arising from your failure to protect your account
        credentials.
      </p>
      <h3 className={subTitle}>3.3 One Account Per Person</h3>
      <p className={paragraph}>
        You may not create or use multiple accounts to circumvent restrictions
        or impersonate another person. We reserve the right to suspend duplicate
        accounts.
      </p>

      <h2 className={sectionTitle}>4. Acceptable Use Policy</h2>
      <p className={paragraph}>
        You agree that you will <span className={inlineStrong}>not</span>:
      </p>
      <ul className="list-disc pl-6 mb-3">
        <li className={bullet}>
          Use the Service for any unlawful purpose, or in violation of any
          local, national, or international law.
        </li>
        <li className={bullet}>
          Track or analyze social profiles that you do not own or are not
          authorized to track.
        </li>
        <li className={bullet}>
          Attempt to gain unauthorized access to any part of the Service, its
          systems, or its data.
        </li>
        <li className={bullet}>
          Interfere with or disrupt the Service, including by introducing
          malware, conducting denial-of-service attacks, or excessive automated
          requests.
        </li>
        <li className={bullet}>
          Reverse engineer, decompile, or disassemble any part of the Service,
          except where permitted by law.
        </li>
        <li className={bullet}>
          Resell, sublicense, or commercially exploit the Service without our
          prior written consent.
        </li>
        <li className={bullet}>
          Use the Service to harass, defame, or harm any other person or entity.
        </li>
        <li className={bullet}>
          Scrape, harvest, or otherwise collect data from the Service except
          through features we expressly provide for that purpose.
        </li>
        <li className={bullet}>
          Violate the terms of service of any connected social media platform
          (such as Meta or TikTok) through your use of the Service.
        </li>
      </ul>

      <h2 className={sectionTitle}>5. Tracked Social Profiles</h2>
      <h3 className={subTitle}>5.1 Profiles You Own</h3>
      <p className={paragraph}>
        D3 Creator tracks public social profiles that are added on your behalf
        by your agency. You represent and warrant that you own, or have explicit
        permission to have us track and analyze, every profile associated with
        your account.
      </p>
      <h3 className={subTitle}>5.2 Public Data</h3>
      <p className={paragraph}>
        The Service collects{' '}
        <span className={inlineStrong}>publicly available data only</span> from
        the public profile URL of each tracked profile (Instagram, Facebook,
        TikTok, Douyin), using trusted third-party data providers. Your use of
        the Service must comply with each platform&rsquo;s own terms and all
        applicable laws.
      </p>

      <h2 className={sectionTitle}>6. Analytics Data</h2>
      <p className={paragraph}>
        The Service displays analytics derived from publicly available social
        media data, collected through trusted third-party data providers. We do
        not guarantee:
      </p>
      <ul className="list-disc pl-6 mb-3">
        <li className={bullet}>
          The accuracy, completeness, or timeliness of any analytics data
          displayed.
        </li>
        <li className={bullet}>
          The continued availability of any platform integration, which may
          change or be removed if the underlying platform changes its API.
        </li>
        <li className={bullet}>
          That historical data will be retained indefinitely.
        </li>
      </ul>
      <p className={paragraph}>
        Analytics data is provided for informational purposes only and should
        not be the sole basis for business or financial decisions.
      </p>

      <h2 className={sectionTitle}>7. Intellectual Property</h2>
      <h3 className={subTitle}>7.1 Our Rights</h3>
      <p className={paragraph}>
        The Service, including its software, design, branding (such as the
        &ldquo;D3 Creator&rdquo; name and logo), and content (excluding User
        Content), is owned by us or our licensors and is protected by copyright,
        trademark, and other intellectual property laws.
      </p>
      <h3 className={subTitle}>7.2 Your Rights</h3>
      <p className={paragraph}>
        Subject to your compliance with these Terms, we grant you a limited,
        non-exclusive, non-transferable, revocable licence to access and use the
        Service for your personal or internal business purposes.
      </p>
      <h3 className={subTitle}>7.3 Your Content</h3>
      <p className={paragraph}>
        You retain all rights to your own social media content. The Service
        collects only publicly available data from the profiles your agency
        tracks and uses it solely for the purpose of providing the Service to
        you.
      </p>

      <h2 className={sectionTitle}>8. Third-Party Services</h2>
      <p className={paragraph}>
        The Service relies on third-party services including TikHub and
        BrightData (public social-data collection), Supabase (database and
        storage), and Vercel (hosting). Your use of these third-party services
        is governed by their own terms and privacy policies. We are not
        responsible for the practices, availability, or content of any third
        party.
      </p>

      <h2 className={sectionTitle}>
        9. No Guarantee of Uptime or Availability
      </h2>
      <p className={paragraph}>
        We strive to keep the Service available, but we do not guarantee that
        the Service will be uninterrupted, error-free, secure, or available at
        any particular time or location. The Service may be temporarily
        unavailable due to maintenance, upgrades, or events outside our
        reasonable control (including outages of third-party APIs and hosting
        providers).
      </p>
      <p className={paragraph}>
        We are not liable for any downtime, data loss, or inconvenience caused
        by such unavailability.
      </p>

      <h2 className={sectionTitle}>10. Disclaimer of Warranties</h2>
      <p className={paragraph}>
        TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE SERVICE IS
        PROVIDED ON AN &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE&rdquo; BASIS,
        WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY.
        WE DISCLAIM ALL WARRANTIES, INCLUDING IMPLIED WARRANTIES OF
        MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, AND
        TITLE.
      </p>
      <p className={paragraph}>
        We make no warranty that the Service will meet your requirements, be
        free of errors, or produce any specific result. Any reliance on the
        analytics data or other materials provided through the Service is at
        your sole risk.
      </p>

      <h2 className={sectionTitle}>11. Limitation of Liability</h2>
      <p className={paragraph}>
        TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL D3
        CREATOR, ITS OFFICERS, DIRECTORS, EMPLOYEES, AGENTS, OR LICENSORS BE
        LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE
        DAMAGES, INCLUDING WITHOUT LIMITATION LOSS OF PROFITS, REVENUE, DATA,
        GOODWILL, OR OTHER INTANGIBLE LOSSES, ARISING OUT OF OR IN CONNECTION
        WITH YOUR USE OF, OR INABILITY TO USE, THE SERVICE.
      </p>
      <p className={paragraph}>
        IN ALL CASES, OUR AGGREGATE LIABILITY ARISING OUT OF OR RELATING TO
        THESE TERMS OR THE SERVICE SHALL NOT EXCEED THE AMOUNT YOU PAID US IN
        THE TWELVE (12) MONTHS PRECEDING THE EVENT GIVING RISE TO THE LIABILITY,
        OR ONE HUNDRED MALAYSIAN RINGGIT (MYR 100), WHICHEVER IS GREATER. WHERE
        YOU USE THE SERVICE WITHOUT PAYMENT, OUR AGGREGATE LIABILITY IS CAPPED
        AT MYR 100.
      </p>

      <h2 className={sectionTitle}>12. Indemnification</h2>
      <p className={paragraph}>
        You agree to indemnify, defend, and hold harmless D3 Creator and its
        affiliates, officers, agents, and employees from and against any claims,
        liabilities, damages, losses, and expenses (including reasonable legal
        fees) arising out of or in any way connected with:
      </p>
      <ul className="list-disc pl-6 mb-3">
        <li className={bullet}>
          Your use of, or inability to use, the Service.
        </li>
        <li className={bullet}>Your violation of these Terms.</li>
        <li className={bullet}>
          Your violation of any third-party right, including the terms of any
          social media platform tracked through the Service.
        </li>
        <li className={bullet}>
          Any content or data you submit to the Service.
        </li>
      </ul>

      <h2 className={sectionTitle}>13. Termination</h2>
      <h3 className={subTitle}>13.1 Termination by You</h3>
      <p className={paragraph}>
        You may stop using the Service at any time and ask your agency to close
        your account. Upon deletion, we will process your data in accordance
        with our{' '}
        <a className={linkClass} href="/privacy">
          Privacy Policy
        </a>
        .
      </p>
      <h3 className={subTitle}>13.2 Termination by Us</h3>
      <p className={paragraph}>
        We may suspend or terminate your access to the Service immediately,
        without prior notice or liability, for any reason, including if you
        breach these Terms, engage in fraudulent or abusive behaviour, or if we
        discontinue the Service.
      </p>
      <h3 className={subTitle}>13.3 Effect of Termination</h3>
      <p className={paragraph}>
        Upon termination, your right to use the Service ceases immediately.
        Sections that by their nature should survive termination (including
        intellectual property, disclaimers, limitation of liability,
        indemnification, and governing law) will continue to apply.
      </p>

      <h2 className={sectionTitle}>
        14. Changes to the Service and These Terms
      </h2>
      <p className={paragraph}>
        We may modify or discontinue any part of the Service at any time. We may
        also revise these Terms from time to time. When we make material
        changes, we will update the &ldquo;Last Updated&rdquo; date and, where
        appropriate, provide a more prominent notice. Your continued use of the
        Service after the changes take effect constitutes acceptance of the
        revised Terms. If you do not agree to the updated Terms, you must stop
        using the Service.
      </p>

      <h2 className={sectionTitle}>15. Governing Law and Dispute Resolution</h2>
      <p className={paragraph}>
        These Terms and any dispute arising out of or in connection with them
        shall be governed by and construed in accordance with the laws of{' '}
        <span className={inlineStrong}>Malaysia</span>, without regard to its
        conflict of laws principles.
      </p>
      <p className={paragraph}>
        You and D3 Creator agree that the courts of Malaysia shall have
        exclusive jurisdiction to settle any dispute arising out of or in
        connection with these Terms or the Service, except where such exclusive
        jurisdiction would deprive you of mandatory consumer protections
        available to you under the law of your country of residence.
      </p>

      <h2 className={sectionTitle}>16. Miscellaneous</h2>
      <h3 className={subTitle}>16.1 Entire Agreement</h3>
      <p className={paragraph}>
        These Terms, together with the Privacy Policy, constitute the entire
        agreement between you and D3 Creator regarding the Service and supersede
        any prior agreements.
      </p>
      <h3 className={subTitle}>16.2 Severability</h3>
      <p className={paragraph}>
        If any provision of these Terms is found to be unenforceable or invalid,
        that provision shall be limited or eliminated to the minimum extent
        necessary so that these Terms shall otherwise remain in full force and
        effect.
      </p>
      <h3 className={subTitle}>16.3 No Waiver</h3>
      <p className={paragraph}>
        Our failure to enforce any right or provision of these Terms will not be
        considered a waiver of that right or provision.
      </p>
      <h3 className={subTitle}>16.4 Assignment</h3>
      <p className={paragraph}>
        You may not assign or transfer these Terms without our prior written
        consent. We may assign these Terms freely, including in connection with
        a merger, acquisition, or sale of assets.
      </p>

      <h2 className={sectionTitle}>17. Contact Us</h2>
      <p className={paragraph}>
        If you have any questions about these Terms, please contact us at:
      </p>
      <GlassCard variant="base" padding="md" radius="xl" className="my-6">
        <p className="text-body-sm text-fgMuted mb-2">
          <span className={inlineStrong}>D3 Creator</span>
        </p>
        <p className="text-body-sm text-fgMuted">
          Email:{' '}
          <a className={linkClass} href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
        </p>
      </GlassCard>

      <div className="mt-12 pt-6 border-t border-borderGlass">
        <p className="text-caption text-fgSubtle">
          These Terms of Service are provided as a general informational
          template and do not constitute legal advice. You are responsible for
          ensuring compliance with all laws applicable to your specific
          operations. We strongly recommend consulting a qualified legal
          professional in Malaysia before relying on these terms for production
          use.
        </p>
      </div>
    </article>
  );
}
