import { ImageResponse } from 'next/og';

// Default social-share card for all public pages (Next auto-wires og:image +
// twitter:image, with correct 1200x630 dimensions). Generated at the edge —
// no static asset to maintain. Brand: #0A0A0D canvas, #F2E600 mark.
export const alt = 'D3 Creator — login-free social analytics';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 80,
        backgroundColor: '#0A0A0D',
        color: '#FFFFFF',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 16,
            backgroundColor: '#F2E600',
          }}
        />
        <div style={{ display: 'flex', fontSize: 40, fontWeight: 700 }}>
          D3 Creator
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            display: 'flex',
            fontSize: 72,
            fontWeight: 800,
            lineHeight: 1.05,
            letterSpacing: -2,
            maxWidth: 960,
          }}
        >
          We don’t sell dreams. We show numbers.
        </div>
        <div
          style={{
            display: 'flex',
            marginTop: 28,
            fontSize: 30,
            color: 'rgba(255,255,255,0.62)',
          }}
        >
          Login-free social analytics across every platform.
        </div>
      </div>
      <div style={{ display: 'flex', fontSize: 26, color: '#F2E600' }}>
        www.d3creator.com
      </div>
    </div>,
    { ...size },
  );
}
