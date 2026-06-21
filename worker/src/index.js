// worker/src/index.js
// Standalone Cloudflare Worker for Balfen Admin Portal API
// No dependencies required! Deploy directly using Wrangler.

const JWT_HEADER = { alg: "HS256", typ: "JWT" };

// Helper to generate a simple JWT token for session management
async function generateJWT(payload, secret) {
  const encoder = new TextEncoder();
  const headerBase64 = btoa(JSON.stringify(JWT_HEADER)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const payloadBase64 = btoa(JSON.stringify(payload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${headerBase64}.${payloadBase64}`)
  );
  
  const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
    
  return `${headerBase64}.${payloadBase64}.${signatureBase64}`;
}

// Helper to verify JWT token
async function verifyJWT(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    
    const [headerB64, payloadB64, signatureB64] = parts;
    const encoder = new TextEncoder();
    
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    
    const data = encoder.encode(`${headerB64}.${payloadB64}`);
    const sigStr = atob(signatureB64.replace(/-/g, "+").replace(/_/g, "/"));
    const sigBuf = new Uint8Array(sigStr.length);
    for (let i = 0; i < sigStr.length; i++) {
      sigBuf[i] = sigStr.charCodeAt(i);
    }
    
    const isValid = await crypto.subtle.verify("HMAC", key, sigBuf, data);
    if (!isValid) return null;
    
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")));
    if (payload.exp && Date.now() > payload.exp) return null;
    
    return payload;
  } catch (e) {
    return null;
  }
}

// Helper for CORS headers
function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": "*", // You can restrict this to https://balfen.com in production
    "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(env);
    
    // Handle OPTIONS preflight request
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }
    
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Setup Supabase and Resend API configs from environment bindings
    const supabaseUrl = env.SUPABASE_URL;
    const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY; // Use Service Role Key for admin backend access
    const resendApiKey = env.RESEND_API_KEY;
    const jwtSecret = env.JWT_SECRET;
    const webhookSecret = env.WEBHOOK_SECRET;
    const allowedAdminEmails = (env.ALLOWED_ADMIN_EMAILS || "balfengroup@gmail.com,info@balfen.com").split(",");

    // Supabase request helper
    const supabaseFetch = async (endpoint, method = "GET", body = null, headers = {}) => {
      const options = {
        method,
        headers: {
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
          "Prefer": "return=representation",
          ...headers
        }
      };
      if (body) options.body = JSON.stringify(body);
      
      const res = await fetch(`${supabaseUrl}/rest/v1/${endpoint}`, options);
      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Supabase Error: ${res.status} - ${errorText}`);
      }
      return res.json();
    };

    try {
      // ─── 1. PUBLIC ROUTES ───

      // Send passwordless OTP
      if (path === "/api/auth/send-otp" && request.method === "POST") {
        const { email } = await request.json();
        const trimmedEmail = email.trim().toLowerCase();
        
        if (!allowedAdminEmails.includes(trimmedEmail)) {
          return new Response(JSON.stringify({ error: "Access denied: Unauthorized email" }), {
            status: 403,
            headers: { "Content-Type": "application/json", ...cors }
          });
        }
        
        // Generate 6-digit OTP
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes from now
        
        // Save to Supabase public.auth_otps using upsert
        await supabaseFetch("auth_otps", "POST", {
          email: trimmedEmail,
          otp_code: otpCode,
          expires_at: expiresAt
        }, { "Prefer": "resolution=merge-duplicates" });
        
        // Send email via Resend
        const emailBody = `
          <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px; background: #fafafa;">
            <div style="text-align: center; margin-bottom: 20px;">
              <h2 style="color: #FF5A00; margin: 0; text-transform: uppercase; font-weight: 900; letter-spacing: 1px;">BALFEN GROUP</h2>
              <div style="font-size: 12px; color: #888; margin-top: 5px;">Admin Portal Login</div>
            </div>
            <p>Your one-time password (OTP) is:</p>
            <div style="font-size: 32px; font-weight: bold; text-align: center; letter-spacing: 5px; padding: 15px; background: #e0e0e0; border-radius: 5px; margin: 20px 0; color: #1E1E1A;">
              ${otpCode}
            </div>
            <p style="font-size: 12px; color: #666; text-align: center;">This code is valid for 10 minutes. If you did not request this code, please ignore this email.</p>
          </div>
        `;
        
        const resendRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${resendApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            from: "Balfen Group <info@balfen.com>",
            to: trimmedEmail,
            subject: `${otpCode} is your Balfen Login Code`,
            html: emailBody
          })
        });
        
        if (!resendRes.ok) {
          const resendErr = await resendRes.text();
          throw new Error(`Resend send-otp failed: ${resendErr}`);
        }
        
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json", ...cors }
        });
      }
      
      // Verify OTP and generate session token
      if (path === "/api/auth/verify-otp" && request.method === "POST") {
        const { email, otp } = await request.json();
        const trimmedEmail = email.trim().toLowerCase();
        
        // Query OTP from Supabase
        const otps = await supabaseFetch(`auth_otps?email=eq.${encodeURIComponent(trimmedEmail)}`);
        
        if (otps.length === 0) {
          return new Response(JSON.stringify({ error: "Invalid login attempt" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...cors }
          });
        }
        
        const otpRecord = otps[0];
        const now = new Date();
        const expiresAt = new Date(otpRecord.expires_at);
        
        if (otpRecord.otp_code !== otp.trim() || now > expiresAt) {
          return new Response(JSON.stringify({ error: "Invalid or expired code" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...cors }
          });
        }
        
        // Delete verified OTP
        const deleteOptions = {
          method: "DELETE",
          headers: {
            "apikey": supabaseKey,
            "Authorization": `Bearer ${supabaseKey}`
          }
        };
        await fetch(`${supabaseUrl}/rest/v1/auth_otps?email=eq.${encodeURIComponent(trimmedEmail)}`, deleteOptions);
        
        // Create JWT token valid for 30 days
        const exp = Date.now() + 30 * 24 * 60 * 60 * 1000;
        const token = await generateJWT({ email: trimmedEmail, exp }, jwtSecret);
        
        return new Response(JSON.stringify({ success: true, token, expiresAt: new Date(exp).toISOString() }), {
          headers: { "Content-Type": "application/json", ...cors }
        });
      }
      
      // Inbound webhook from Resend
      if (path === "/api/inbound-webhook" && request.method === "POST") {
        // Authenticate webhook via query secret
        const secret = url.searchParams.get("secret");
        if (secret !== webhookSecret) {
          return new Response(JSON.stringify({ error: "Unauthorized webhook access" }), {
            status: 401,
            headers: { "Content-Type": "application/json", ...cors }
          });
        }
        
        const payload = await request.json();
        
        // Resend triggers webhook for 'email.received'
        if (payload.type === "email.received" && payload.data) {
          const emailData = payload.data;
          
          // Insert received email to Supabase
          await supabaseFetch("received_emails", "POST", {
            resend_email_id: emailData.id,
            sender_email: emailData.from.email || emailData.from.value || emailData.from,
            sender_name: emailData.from.name || "",
            subject: emailData.subject,
            body_text: emailData.text || "",
            body_html: emailData.html || "",
            thread_id: emailData.thread_id || emailData.id,
            is_read: false,
            received_at: emailData.created_at || new Date().toISOString()
          });
        }
        
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json", ...cors }
        });
      }
      
      // ─── 2. PROTECTED ROUTES (Requires JWT authentication) ───
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return new Response(JSON.stringify({ error: "Missing authorization token" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...cors }
        });
      }
      
      const token = authHeader.split(" ")[1];
      const verifiedPayload = await verifyJWT(token, jwtSecret);
      
      if (!verifiedPayload) {
        return new Response(JSON.stringify({ error: "Invalid or expired session" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...cors }
        });
      }
      
      // API Calendar routing
      if (path.startsWith("/api/calendar")) {
        const queryParams = url.search || "";
        
        if (request.method === "GET") {
          const data = await supabaseFetch(`jobs_calendar${queryParams}`);
          return new Response(JSON.stringify(data), {
            headers: { "Content-Type": "application/json", ...cors }
          });
        }
        
        if (request.method === "POST") {
          const body = await request.json();
          const data = await supabaseFetch("jobs_calendar", "POST", body);
          return new Response(JSON.stringify(data), {
            headers: { "Content-Type": "application/json", ...cors }
          });
        }
        
        if (request.method === "PUT") {
          const id = url.searchParams.get("id");
          if (!id) throw new Error("Missing job id query parameter");
          
          const body = await request.json();
          const data = await supabaseFetch(`jobs_calendar?id=eq.${id}`, "PATCH", body);
          return new Response(JSON.stringify(data), {
            headers: { "Content-Type": "application/json", ...cors }
          });
        }
        
        if (request.method === "DELETE") {
          const id = url.searchParams.get("id");
          if (!id) throw new Error("Missing job id query parameter");
          
          // Custom fetch to handle empty response on delete representation
          const res = await fetch(`${supabaseUrl}/rest/v1/jobs_calendar?id=eq.${id}`, {
            method: "DELETE",
            headers: {
              "apikey": supabaseKey,
              "Authorization": `Bearer ${supabaseKey}`
            }
          });
          if (!res.ok) throw new Error("Supabase delete failed");
          
          return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json", ...cors }
          });
        }
      }
      
      // API Invoices routing
      if (path.startsWith("/api/invoices")) {
        const queryParams = url.search || "";
        
        if (request.method === "GET") {
          const data = await supabaseFetch(`invoices${queryParams}`);
          return new Response(JSON.stringify(data), {
            headers: { "Content-Type": "application/json", ...cors }
          });
        }
        
        if (request.method === "POST") {
          const body = await request.json();
          const data = await supabaseFetch("invoices", "POST", body);
          return new Response(JSON.stringify(data), {
            headers: { "Content-Type": "application/json", ...cors }
          });
        }
        
        if (request.method === "PUT") {
          const id = url.searchParams.get("id");
          if (!id) throw new Error("Missing invoice id query parameter");
          
          const body = await request.json();
          const data = await supabaseFetch(`invoices?id=eq.${id}`, "PATCH", body);
          return new Response(JSON.stringify(data), {
            headers: { "Content-Type": "application/json", ...cors }
          });
        }
      }
      
      // API Received Emails routing
      if (path.startsWith("/api/emails")) {
        const queryParams = url.search || "";
        
        if (request.method === "GET") {
          const data = await supabaseFetch(`received_emails${queryParams}`);
          return new Response(JSON.stringify(data), {
            headers: { "Content-Type": "application/json", ...cors }
          });
        }
        
        // Mark read/unread status
        if (request.method === "PUT") {
          const id = url.searchParams.get("id");
          if (!id) throw new Error("Missing email id parameter");
          
          const body = await request.json();
          const data = await supabaseFetch(`received_emails?id=eq.${id}`, "PATCH", body);
          return new Response(JSON.stringify(data), {
            headers: { "Content-Type": "application/json", ...cors }
          });
        }
        
        // Send email / reply via Resend API
        if (request.method === "POST" && path === "/api/emails/send") {
          const { to, subject, htmlBody, plainBody, replyToId } = await request.json();
          
          // Auto applied HTML professional template for Balfen Group
          const styledHtmlBody = `
            <!DOCTYPE html>
            <html>
            <head>
              <meta charset="utf-8">
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #1a1a1a; margin: 0; padding: 0; }
                .container { max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; background: #ffffff; }
                .header { background: #1E1E1A; padding: 25px; text-align: center; border-bottom: 3px solid #FF5A00; }
                .logo-text { font-family: sans-serif; font-weight: 900; font-size: 24px; color: #ffffff; letter-spacing: 2px; text-transform: uppercase; margin: 0; }
                .logo-sub { font-size: 11px; color: #FF5A00; letter-spacing: 3px; text-transform: uppercase; margin-top: 5px; }
                .content { padding: 30px; font-size: 15px; }
                .footer { background: #fafafa; padding: 20px; text-align: center; border-top: 1px solid #eeeeee; font-size: 12px; color: #777777; }
                .footer p { margin: 5px 0; }
                .btn { display: inline-block; padding: 10px 20px; background: #FF5A00; color: #ffffff; text-decoration: none; border-radius: 4px; font-weight: bold; margin-top: 15px; text-transform: uppercase; font-size: 13px; }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <div class="logo-text">Balfen Group</div>
                  <div class="logo-sub">Concreting Specialists &bull; Malta</div>
                </div>
                <div class="content">
                  ${htmlBody}
                </div>
                <div class="footer">
                  <p><strong>Balfen Group</strong> | Concreting Specialists</p>
                  <p>Free Quotes &bull; Serving all of Malta &amp; Gozo</p>
                  <p style="font-size:11px;color:#aaa;margin-top:15px;">© 2026 Balfen Group. All rights reserved.</p>
                </div>
              </div>
            </body>
            </html>
          `;
          
          const resendPayload = {
            from: "Balfen Group <info@balfen.com>",
            to,
            subject,
            html: styledHtmlBody,
            text: plainBody || "Please enable HTML to view this message."
          };
          
          if (replyToId) {
            // Include thread context or headers if needed
            resendPayload.headers = {
              "In-Reply-To": replyToId,
              "References": replyToId
            };
          }
          
          const resendRes = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${resendApiKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(resendPayload)
          });
          
          if (!resendRes.ok) {
            const err = await resendRes.text();
            throw new Error(`Resend sending failed: ${err}`);
          }
          
          const resendData = await resendRes.json();
          
          // Optional: Mark the replied email in our database as read/replied
          if (replyToId) {
            // Find received email by resend_email_id and update status
            await fetch(`${supabaseUrl}/rest/v1/received_emails?resend_email_id=eq.${encodeURIComponent(replyToId)}`, {
              method: "PATCH",
              headers: {
                "apikey": supabaseKey,
                "Authorization": `Bearer ${supabaseKey}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({ is_read: true })
            });
          }
          
          return new Response(JSON.stringify({ success: true, data: resendData }), {
            headers: { "Content-Type": "application/json", ...cors }
          });
        }
      }
      
      // Fallback
      return new Response(JSON.stringify({ error: "Route not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...cors }
      });
      
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...cors }
      });
    }
  }
};
