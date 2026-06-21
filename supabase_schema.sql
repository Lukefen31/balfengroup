-- supabase_schema.sql
-- Run this in the SQL Editor of your Supabase project to set up the database tables

-- 1. JOBS CALENDAR
CREATE TABLE IF NOT EXISTS public.jobs_calendar (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date DATE NOT NULL,
    client_name TEXT NOT NULL,
    job_type TEXT NOT NULL,
    address TEXT,
    notes TEXT,
    status TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. INVOICES
CREATE TABLE IF NOT EXISTS public.invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_number TEXT UNIQUE NOT NULL,
    client_name TEXT NOT NULL,
    client_email TEXT NOT NULL,
    date_issued DATE NOT NULL,
    date_due DATE NOT NULL,
    line_items JSONB NOT NULL DEFAULT '[]'::jsonb,
    total_amount NUMERIC(10, 2) NOT NULL,
    status TEXT DEFAULT 'sent' CHECK (status IN ('draft', 'sent', 'paid', 'overdue')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. RECEIVED EMAILS
CREATE TABLE IF NOT EXISTS public.received_emails (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resend_email_id TEXT UNIQUE,
    sender_email TEXT NOT NULL,
    sender_name TEXT,
    subject TEXT,
    body_text TEXT,
    body_html TEXT,
    thread_id TEXT,
    is_read BOOLEAN DEFAULT false,
    received_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 4. OTP CODES (Passwordless auth)
CREATE TABLE IF NOT EXISTS public.auth_otps (
    email TEXT PRIMARY KEY,
    otp_code TEXT NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable Row Level Security (RLS) or add indexes
CREATE INDEX IF NOT EXISTS idx_jobs_calendar_date ON public.jobs_calendar(date);
CREATE INDEX IF NOT EXISTS idx_received_emails_received_at ON public.received_emails(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_invoice_number ON public.invoices(invoice_number);

-- Enable Realtime for calendar, invoices, and received_emails to sync updates automatically
ALTER PUBLICATION supabase_realtime ADD TABLE public.jobs_calendar;
ALTER PUBLICATION supabase_realtime ADD TABLE public.invoices;
ALTER PUBLICATION supabase_realtime ADD TABLE public.received_emails;
