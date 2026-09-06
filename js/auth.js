// Clerk Publishable Key
const CLERK_PUBLISHABLE_KEY = 'pk_test_a25vd24tbXVzdGFuZy0zNS5jbGVyay5hY2NvdW50cy5kZXYk';

// Derive the Clerk Frontend API host from the publishable key
// pk_test_ prefix is removed, base64-decoded, and trailing '$' stripped
function getClerkFrontendApi(pubKey) {
  const raw = pubKey.replace(/^pk_test_|^pk_live_/, '');
  try {
    return atob(raw).replace(/\$$/, '');
  } catch {
    return null;
  }
}

let clerkReady = false;

// Centralized API Base configuration
const isLocalhostEnv = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
window.API_BASE = isLocalhostEnv ? 'http://localhost:5000' : '';

// Initialize Clerk
async function initClerk() {
  const frontendApi = getClerkFrontendApi(CLERK_PUBLISHABLE_KEY);
  
  const script = document.createElement('script');
  script.setAttribute('data-clerk-publishable-key', CLERK_PUBLISHABLE_KEY);
  
  // Load from Clerk's own proxy CDN — this includes UI components (sign-in, user button, etc.)
  // The jsdelivr CDN only ships the headless bundle without UI components.
  script.src = `https://${frontendApi}/npm/@clerk/clerk-js@latest/dist/clerk.browser.js`;
  script.async = true;
  script.crossOrigin = 'anonymous';
  
  script.addEventListener('load', async () => {
    await window.Clerk.load({
      appearance: {
        variables: { colorPrimary: '#FF9933' }
      }
    });
    
    clerkReady = true;
    window.clerkReady = true;

    const handleAuthLoad = () => {
      const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      if (window.Clerk.user) {
        renderUserMenu();
        window.dispatchEvent(new Event('clerk-ready'));
      } else if (isLocalhost) {
        console.log('🧪 Localhost dev fallback: authenticated as Dev User');
        const authContainer = document.getElementById('auth-container');
        if (authContainer) {
          authContainer.innerHTML = '<div class="flex items-center gap-2"><span class="px-2 py-0.5 bg-primary/10 text-primary text-[10px] font-bold rounded">Dev Mode</span><button id="clerk-sign-in-btn" class="bg-primary text-white px-3 py-1.5 rounded-lg font-medium hover:bg-[#e68a2e] transition-all text-xs">Sign In</button></div>';
          document.getElementById('clerk-sign-in-btn').addEventListener('click', () => {
            try { window.Clerk.openSignIn(); } catch (err) { window.Clerk.redirectToSignIn(); }
          });
        }
        window.dispatchEvent(new Event('clerk-ready'));
      } else {
        renderSignInButton();
      }
    };

    handleAuthLoad();
  });

  script.addEventListener('error', () => {
    console.error('Failed to load Clerk JS from proxy CDN, falling back to jsdelivr');
    // Fallback: try jsdelivr (headless, openSignIn won't work but redirectToSignIn will)
    const fallback = document.createElement('script');
    fallback.setAttribute('data-clerk-publishable-key', CLERK_PUBLISHABLE_KEY);
    fallback.src = `https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js`;
    fallback.async = true;
    fallback.crossOrigin = 'anonymous';
    fallback.addEventListener('load', async () => {
      await window.Clerk.load({
        appearance: { variables: { colorPrimary: '#FF9933' } }
      });
      clerkReady = true;
      window.clerkReady = true;
      
      const handleAuthLoadFallback = () => {
        const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        if (window.Clerk.user) {
          renderUserMenu();
          window.dispatchEvent(new Event('clerk-ready'));
        } else if (isLocalhost) {
          console.log('🧪 Localhost dev fallback (fallback CDN): authenticated as Dev User');
          const authContainer = document.getElementById('auth-container');
          if (authContainer) {
            authContainer.innerHTML = '<div class="flex items-center gap-2"><span class="px-2 py-0.5 bg-primary/10 text-primary text-[10px] font-bold rounded">Dev Mode</span><button id="clerk-sign-in-btn" class="bg-primary text-white px-3 py-1.5 rounded-lg font-medium hover:bg-[#e68a2e] transition-all text-xs">Sign In</button></div>';
            document.getElementById('clerk-sign-in-btn').addEventListener('click', () => {
              try { window.Clerk.redirectToSignIn(); } catch (err) { window.Clerk.redirectToSignIn(); }
            });
          }
          window.dispatchEvent(new Event('clerk-ready'));
        } else {
          renderSignInButton();
        }
      };
      
      handleAuthLoadFallback();
    });
    document.head.appendChild(fallback);
  });

  document.head.appendChild(script);
}

function renderUserMenu() {
  const authContainer = document.getElementById('auth-container');
  if (authContainer) {
    authContainer.innerHTML = '<div id="user-button"></div>';
    window.Clerk.mountUserButton(document.getElementById('user-button'));
  }
}

function renderSignInButton() {
  const authContainer = document.getElementById('auth-container');
  if (authContainer) {
    authContainer.innerHTML = '<button id="clerk-sign-in-btn" class="bg-primary text-white px-4 py-2 rounded-lg font-medium hover:bg-[#e68a2e] transition-all text-sm">Sign In</button>';
    document.getElementById('clerk-sign-in-btn').addEventListener('click', () => {
      // Try openSignIn first (works with full bundle from proxy CDN)
      // Fall back to redirectToSignIn (works with headless bundle too)
      try {
        window.Clerk.openSignIn();
      } catch (err) {
        console.warn('openSignIn unavailable, redirecting instead:', err.message);
        window.Clerk.redirectToSignIn();
      }
    });
  }
}

// Wrapper for fetch that automatically adds the Clerk Bearer token
async function apiFetch(endpoint, options = {}) {
  if (!clerkReady) {
    console.warn('Clerk is not ready yet');
  }

  const token = window.Clerk && window.Clerk.session 
    ? await window.Clerk.session.getToken() 
    : null;

  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Automatically switch to relative paths in production (Vercel)
  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  let finalEndpoint = endpoint;
  if (!isLocalhost && finalEndpoint.startsWith('http://localhost:5000')) {
    finalEndpoint = finalEndpoint.replace('http://localhost:5000', '');
  }

  const response = await fetch(finalEndpoint, {
    ...options,
    headers
  });

  return response;
}

// Global API Request Helper with retry
window.apiRequest = async function(method, path, body = null, retries = 1) {
  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const API_BASE = isLocalhost ? 'http://localhost:5000' : '';
  const fullUrl = path.startsWith('http') ? path : `${API_BASE}${path}`;
  
  const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await window.apiFetch(fullUrl, opts);
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        let errData = null;
        try { errData = await res.json(); } catch {}
        return errData || { success: false, status: res.status, error: `Request returned HTTP ${res.status}` };
      }

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        if (!res.ok) {
          return { success: false, status: res.status, error: `Server returned HTTP ${res.status}` };
        }
        throw parseErr;
      }
      return data;
    } catch (err) {
      if (attempt < retries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 2000);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      console.warn(`API Error [${method} ${path}]:`, err?.message || err);
      return { success: false, error: err?.message || 'Network error' };
    }
  }
}

// Register Service Worker for PWA
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

// Start initialization
window.addEventListener('DOMContentLoaded', () => {
  initClerk();
  registerSW();
});

// Expose apiFetch globally
window.apiFetch = apiFetch;
