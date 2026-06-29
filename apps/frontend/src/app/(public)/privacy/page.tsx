import { Metadata } from 'next';
import { GlassCard } from '@gitroom/frontend/components/ui/glass-card';
import {
  SITE_URL,
  SITE_DOMAIN,
  PRIVACY_EMAIL,
} from '@gitroom/frontend/lib/site';

export const dynamic = 'force-static';
export const revalidate = false;

export const metadata: Metadata = {
  title: 'Privacy Policy — D3 Creator',
  description:
    'D3 Creator Privacy Policy: how we collect, use, and protect your information when you use our social media analytics service.',
  alternates: { canonical: '/privacy' },
};

const sectionTitle = 'text-section mt-12 mb-4 text-fg';
const subTitle = 'text-subsection mt-8 mb-3 text-fg';
const paragraph = 'text-body text-fgMuted mb-4';
const bullet = 'text-body text-fgMuted mb-2';
const linkClass =
  'text-brand hover:text-brand-light transition-colors underline underline-offset-4 decoration-brand/40 hover:decoration-brand-light/60';
const inlineStrong = 'text-fg font-semibold';

export default function PrivacyPage() {
  return (
    <article className="max-w-[720px] mx-auto pt-12 pb-24">
      <header className="mb-12 pb-8 border-b border-borderGlass">
        <span className="inline-flex items-center px-2.5 py-1 rounded-full glass-subtle border border-borderGlass text-caption text-fgMuted mb-6">
          Legal
        </span>
        <h1 className="text-display-2 text-fg mb-4">Privacy Policy</h1>
        <p className="text-caption text-fgSubtle">
          Effective Date: 1 January 2025 · Last Updated: 29 June 2026
        </p>
      </header>

      <p className={paragraph}>
        D3 Creator (&ldquo;<span className={inlineStrong}>D3 Creator</span>
        &rdquo;, &ldquo;we&rdquo;, &ldquo;our&rdquo;, or &ldquo;us&rdquo;) is
        committed to protecting your privacy. This Privacy Policy explains how
        we collect, use, store, and disclose your personal information when you
        use our website at{' '}
        <a className={linkClass} href={SITE_URL}>
          {SITE_DOMAIN}
        </a>{' '}
        and our related social media analytics services (collectively, the
        &ldquo;Service&rdquo;).
      </p>
      <p className={paragraph}>
        By accessing or using the Service, you agree to the collection and use
        of information in accordance with this Privacy Policy. This policy is
        designed to comply with the European Union General Data Protection
        Regulation (&ldquo;<span className={inlineStrong}>GDPR</span>&rdquo;)
        and the Malaysian Personal Data Protection Act 2010 (&ldquo;
        <span className={inlineStrong}>PDPA</span>&rdquo;), as well as other
        applicable data protection laws.
      </p>

      <h2 className={sectionTitle}>1. Information We Collect</h2>
      <p className={paragraph}>
        We collect the following categories of information when you register for
        or use the Service:
      </p>

      <h3 className={subTitle}>1.1 Account Information</h3>
      <ul className="list-disc pl-6 mb-3">
        <li className={bullet}>Your full name (or display name)</li>
        <li className={bullet}>Your email address</li>
        <li className={bullet}>
          An encrypted password (we never store plain-text passwords)
        </li>
        <li className={bullet}>Account preferences and settings</li>
      </ul>

      <h3 className={subTitle}>1.2 Tracked Social Profiles</h3>
      <p className={paragraph}>
        D3 Creator is an agency-managed service: your agency adds the public
        social profiles that belong to you (on Instagram, Facebook, TikTok, or
        Douyin), and we collect publicly available data from those profiles. For
        each tracked profile we collect:
      </p>
      <ul className="list-disc pl-6 mb-3">
        <li className={bullet}>
          The public profile URL and handle supplied by your agency
        </li>
        <li className={bullet}>
          Public profile information (such as username, display name, profile
          picture, follower and following counts)
        </li>
        <li className={bullet}>
          Publicly visible posts and their public engagement metrics (views,
          likes, comments, shares)
        </li>
      </ul>
      <p className={paragraph}>
        For tracked profiles, we only collect information that is publicly
        visible on the platform. We do not access private messages, private
        posts, or any non-public data through public profile tracking.
      </p>

      <h3 className={subTitle}>1.3 Analytics & Usage Data</h3>
      <ul className="list-disc pl-6 mb-3">
        <li className={bullet}>
          Aggregated metrics about the tracked accounts (followers, views,
          engagement rate, likes, comments, shares)
        </li>
        <li className={bullet}>
          Time-series snapshots of these metrics so we can show you growth
          charts
        </li>
        <li className={bullet}>
          Service usage information (pages visited, features used, session
          duration) collected through privacy-friendly analytics
        </li>
      </ul>

      <h3 className={subTitle}>1.5 Technical Information</h3>
      <ul className="list-disc pl-6 mb-3">
        <li className={bullet}>
          IP address and approximate location (country / region)
        </li>
        <li className={bullet}>
          Browser type and version, device type, operating system
        </li>
        <li className={bullet}>
          Log data such as access timestamps and referrer URLs
        </li>
      </ul>

      <h2 className={sectionTitle}>2. How We Use Your Information</h2>
      <p className={paragraph}>
        We use the information we collect for the following purposes:
      </p>
      <ul className="list-disc pl-6 mb-3">
        <li className={bullet}>
          To provide and display analytics for the tracked social media accounts
          in your D3 Creator dashboard
        </li>
        <li className={bullet}>To create and manage your D3 Creator account</li>
        <li className={bullet}>
          To authenticate you and keep your account secure
        </li>
        <li className={bullet}>
          To improve, maintain, and operate the Service
        </li>
        <li className={bullet}>
          To respond to your support requests and communicate with you about
          your account or important service notices
        </li>
        <li className={bullet}>
          To detect, prevent, and address technical issues, fraud, or abuse
        </li>
        <li className={bullet}>To comply with our legal obligations</li>
      </ul>
      <p className={paragraph}>
        We process your personal data on the following lawful bases under the
        GDPR:{' '}
        <span className={inlineStrong}>(a) performance of a contract</span> with
        you (providing the Service);{' '}
        <span className={inlineStrong}>(b) your consent</span> (where
        applicable, for marketing communications or optional features); and{' '}
        <span className={inlineStrong}>(c) our legitimate interests</span> in
        operating, securing, and improving the Service.
      </p>

      <h2 className={sectionTitle}>3. Third-Party Services We Use</h2>
      <p className={paragraph}>
        D3 Creator relies on the following third-party services to deliver its
        features. Each third party is responsible for its own data handling
        under its own privacy policy.
      </p>
      <ul className="list-disc pl-6 mb-3">
        <li className={bullet}>
          <span className={inlineStrong}>TikHub</span> — used to collect
          publicly available profile and post data from Instagram, TikTok, and
          Douyin.
        </li>
        <li className={bullet}>
          <span className={inlineStrong}>BrightData</span> — used to collect
          publicly available profile and post data from Facebook.
        </li>
        <li className={bullet}>
          <span className={inlineStrong}>
            Supabase (PostgreSQL hosting & storage)
          </span>{' '}
          — used to securely store account information, analytics data, and
          cached media. Supabase&rsquo;s data centers operate in the region we
          select and follow industry-standard security practices.
        </li>
        <li className={bullet}>
          <span className={inlineStrong}>Vercel</span> — used to host the web
          application and serve it to your browser.
        </li>
      </ul>

      <h2 className={sectionTitle}>4. Data Storage and Security</h2>
      <p className={paragraph}>
        Your personal data is stored in a PostgreSQL database hosted by
        Supabase. We implement appropriate technical and organisational
        safeguards to protect your information, including:
      </p>
      <ul className="list-disc pl-6 mb-3">
        <li className={bullet}>
          Encryption of data in transit using TLS / HTTPS
        </li>
        <li className={bullet}>
          Encryption of data at rest at the database provider level
        </li>
        <li className={bullet}>
          Passwords stored using one-way cryptographic hashing (bcrypt)
        </li>
        <li className={bullet}>
          Access controls and authentication for our administrative systems
        </li>
        <li className={bullet}>Regular monitoring for security incidents</li>
      </ul>
      <p className={paragraph}>
        While we use commercially reasonable efforts to protect your data, no
        method of internet transmission or electronic storage is 100% secure. We
        cannot guarantee absolute security.
      </p>

      <h2 className={sectionTitle}>5. Data Retention</h2>
      <p className={paragraph}>
        We retain your personal data for as long as your account remains active.
        If you delete your account, we will delete or anonymise your personal
        information within ninety (90) days, except where we are required by law
        to retain it longer (for example, for tax or accounting purposes).
      </p>

      <h2 className={sectionTitle}>6. Your Rights</h2>
      <p className={paragraph}>
        Subject to applicable law, you have the following rights regarding your
        personal data:
      </p>
      <ul className="list-disc pl-6 mb-3">
        <li className={bullet}>
          <span className={inlineStrong}>Right to access</span> — you may
          request a copy of the personal data we hold about you.
        </li>
        <li className={bullet}>
          <span className={inlineStrong}>Right to rectification</span> — you may
          ask us to correct inaccurate or incomplete personal data.
        </li>
        <li className={bullet}>
          <span className={inlineStrong}>
            Right to deletion (&ldquo;right to be forgotten&rdquo;)
          </span>{' '}
          — you may request that we delete your personal data.
        </li>
        <li className={bullet}>
          <span className={inlineStrong}>Right to data portability</span> — you
          may request to receive your data in a structured, commonly used,
          machine-readable format.
        </li>
        <li className={bullet}>
          <span className={inlineStrong}>
            Right to restrict or object to processing
          </span>{' '}
          — you may request that we restrict or stop processing your data in
          certain circumstances.
        </li>
        <li className={bullet}>
          <span className={inlineStrong}>Right to withdraw consent</span> —
          where processing is based on your consent, you may withdraw it at any
          time.
        </li>
        <li className={bullet}>
          <span className={inlineStrong}>Right to lodge a complaint</span> — you
          may lodge a complaint with your local data protection authority (in
          Malaysia, the Personal Data Protection Commissioner).
        </li>
      </ul>
      <p className={paragraph}>
        You can exercise these rights by contacting your agency or by emailing
        us at{' '}
        <a className={linkClass} href={`mailto:${PRIVACY_EMAIL}`}>
          {PRIVACY_EMAIL}
        </a>
        . We will respond to your request within thirty (30) days.
      </p>

      <h2 className={sectionTitle}>7. Removing Tracked Profiles</h2>
      <p className={paragraph}>
        Because profiles are added and managed by your agency, you can ask your
        agency to stop tracking any profile at any time. Once a profile is
        removed, we stop collecting new data for it. Historical analytics
        snapshots already collected may remain until they are deleted or your D3
        Creator account is closed.
      </p>
      <p className={paragraph}>
        For public profile tracking, we only collect data that is already public
        on the platform.
      </p>

      <h2 className={sectionTitle}>8. Cookies and Tracking Technologies</h2>
      <p className={paragraph}>
        We use a small number of cookies and similar technologies to operate the
        Service:
      </p>
      <ul className="list-disc pl-6 mb-3">
        <li className={bullet}>
          <span className={inlineStrong}>Strictly necessary cookies</span> —
          required to keep you logged in and to remember your language and theme
          preferences. These cannot be disabled.
        </li>
        <li className={bullet}>
          <span className={inlineStrong}>Analytics cookies</span> —
          privacy-friendly analytics to understand how the Service is used in
          aggregate. No cross-site tracking is performed.
        </li>
      </ul>
      <p className={paragraph}>
        You can control cookies through your browser settings. Disabling
        strictly necessary cookies may prevent the Service from functioning
        correctly.
      </p>

      <h2 className={sectionTitle}>9. International Data Transfers</h2>
      <p className={paragraph}>
        Your information may be transferred to and processed in countries other
        than your country of residence, including the United States and the
        European Union, where our service providers operate. Where required, we
        rely on appropriate safeguards such as the European Commission&rsquo;s
        Standard Contractual Clauses to protect your personal data during these
        transfers.
      </p>

      <h2 className={sectionTitle}>10. Children&rsquo;s Privacy</h2>
      <p className={paragraph}>
        The Service is not intended for individuals under the age of 16. We do
        not knowingly collect personal data from children. If you believe a
        child has provided us with personal data, please contact us and we will
        delete the information promptly.
      </p>

      <h2 className={sectionTitle}>11. Changes to This Privacy Policy</h2>
      <p className={paragraph}>
        We may update this Privacy Policy from time to time. When we do, we will
        revise the &ldquo;Last Updated&rdquo; date at the top of this page. For
        material changes, we will provide a more prominent notice (for example,
        via email or an in-app notification). Your continued use of the Service
        after the changes take effect constitutes acceptance of the revised
        policy.
      </p>

      <h2 className={sectionTitle}>12. Contact Us</h2>
      <p className={paragraph}>
        If you have any questions, concerns, or requests relating to this
        Privacy Policy or your personal data, please contact us at:
      </p>
      <GlassCard variant="base" padding="md" radius="xl" className="my-6">
        <p className="text-body-sm text-fgMuted mb-2">
          <span className={inlineStrong}>D3 Creator</span>
        </p>
        <p className="text-body-sm text-fgMuted">
          Email:{' '}
          <a className={linkClass} href={`mailto:${PRIVACY_EMAIL}`}>
            {PRIVACY_EMAIL}
          </a>
        </p>
      </GlassCard>

      <div className="mt-12 pt-6 border-t border-borderGlass">
        <p className="text-caption text-fgSubtle">
          This Privacy Policy is provided as a general informational template
          and does not constitute legal advice. You are responsible for ensuring
          compliance with all laws applicable to your specific operations. We
          strongly recommend consulting a qualified legal professional before
          relying on this policy for production use.
        </p>
      </div>
    </article>
  );
}
