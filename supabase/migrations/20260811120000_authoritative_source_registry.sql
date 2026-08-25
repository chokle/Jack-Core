-- Metadata-only authority registry. Intentionally no body, extracted text,
-- embedding, file, or blob column. No restricted content is ingested here.
create extension if not exists btree_gist;

create table if not exists public.authoritative_sources (
  source_id text primary key,
  authority text not null,
  jurisdiction text not null
    check (jurisdiction in ('BC_GENERAL', 'VANCOUVER', 'CANADA_MODEL')),
  document_title text not null,
  edition text,
  revision_id text,
  effective_from date,
  effective_to date,
  source_url text not null check (source_url ~ '^https://'),
  source_type text not null check (source_type in (
    'legislation', 'regulation', 'adopted_code', 'model_code',
    'revision_feed', 'bulletin_index', 'municipal_bylaw'
  )),
  supersedes text references public.authoritative_sources(source_id),
  superseded_by text references public.authoritative_sources(source_id),
  citation_label text not null,
  retrieval_priority integer not null default 0,
  status text not null
    check (status in ('current', 'superseded', 'requires_review')),
  license_access_classification text not null check (
    license_access_classification in ('open_legislation', 'restricted_metadata_only')
  ),
  permitted_uses text[] not null
    default array['metadata', 'official_link', 'citation']::text[]
    check (permitted_uses <@ array[
      'metadata', 'official_link', 'citation', 'section_retrieval',
      'model_context', 'embedding'
    ]::text[]),
  authorized_section_locators text[] not null default '{}'::text[],
  verified_at timestamptz not null,
  content_fingerprint text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_from is null or effective_to >= effective_from),
  check (
    source_type not in ('adopted_code', 'municipal_bylaw')
    or (edition is not null and effective_from is not null)
  ),
  check (
    license_access_classification <> 'restricted_metadata_only'
    or not (permitted_uses && array[
      'section_retrieval', 'model_context', 'embedding'
    ]::text[])
  ),
  check (
    license_access_classification <> 'restricted_metadata_only'
    or cardinality(authorized_section_locators) = 0
  )
);

-- Only one governing primary may cover a jurisdiction/edition/date, including
-- superseded historical rows used for replay. Historical rows therefore must
-- close their effective windows before a successor window begins.
alter table public.authoritative_sources
  drop constraint if exists authoritative_sources_no_overlapping_active_primary;
alter table public.authoritative_sources
  add constraint authoritative_sources_no_overlapping_active_primary
  exclude using gist (
    jurisdiction with =,
    source_type with =,
    edition with =,
    daterange(effective_from, effective_to, '[]') with &&
  ) where (
    source_type in ('adopted_code', 'municipal_bylaw')
  );

create index if not exists idx_authoritative_sources_resolution
  on public.authoritative_sources
  (jurisdiction, status, edition, effective_from, effective_to);

alter table public.authoritative_sources enable row level security;
revoke all on table public.authoritative_sources from public, anon, authenticated;
grant select, update on table public.authoritative_sources to service_role;

insert into public.authoritative_sources (
  source_id, authority, jurisdiction, document_title, edition, revision_id,
  effective_from, effective_to, source_url, source_type, supersedes,
  superseded_by, citation_label, retrieval_priority, status,
  license_access_classification, permitted_uses, verified_at,
  content_fingerprint
) values
  (
    'bc-building-act-current', 'Province of British Columbia, King''s Printer',
    'BC_GENERAL', 'Building Act', 'Current consolidation', null, null, null,
    'https://www.bclaws.gov.bc.ca/civix/document/id/consol41/consol41/15002',
    'legislation', null, null, 'Building Act, British Columbia', 100, 'current',
    'open_legislation', array['metadata', 'official_link', 'citation'],
    '2026-08-11T00:00:00Z', null
  ),
  (
    'bc-building-act-general-regulation-current',
    'Province of British Columbia, King''s Printer', 'BC_GENERAL',
    'Building Act General Regulation', 'Current consolidation', null, null, null,
    'https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/131_2016',
    'regulation', null, null,
    'Building Act General Regulation, British Columbia', 100, 'current',
    'open_legislation', array['metadata', 'official_link', 'citation'],
    '2026-08-11T00:00:00Z', null
  ),
  (
    'bc-plumbing-code-2024', 'Province of British Columbia', 'BC_GENERAL',
    'British Columbia Plumbing Code 2024', '2024', null, '2024-03-08', null,
    'https://www2.gov.bc.ca/gov/content/industry/construction-industry/building-codes-standards/bc-codes/2024-bc-codes',
    'adopted_code', null, null, 'BC Plumbing Code 2024', 95, 'current',
    'restricted_metadata_only', array['metadata', 'official_link', 'citation'],
    '2026-08-11T00:00:00Z', null
  ),
  (
    'npc-2020', 'National Research Council Canada', 'CANADA_MODEL',
    'National Plumbing Code of Canada 2020', '2020', null, null, null,
    'https://nrc.canada.ca/en/certifications-evaluations-standards/codes-canada/codes-canada-publications/national-plumbing-code-canada-2020',
    'model_code', null, null, 'National Plumbing Code of Canada 2020', 70,
    'current', 'restricted_metadata_only',
    array['metadata', 'official_link', 'citation'], '2026-08-11T00:00:00Z', null
  ),
  (
    'bc-code-revisions-feed', 'Province of British Columbia', 'BC_GENERAL',
    'BC Building, Plumbing and Fire Code revisions', '2024', 'revision-feed',
    '2024-03-08', null,
    'https://www2.gov.bc.ca/gov/content/industry/construction-industry/building-codes-standards/bc-codes/errata-and-revisions',
    'revision_feed', null, null, 'BC code revisions and errata', 90, 'current',
    'restricted_metadata_only', array['metadata', 'official_link', 'citation'],
    '2026-08-11T00:00:00Z', null
  ),
  (
    'bc-code-bulletin-index', 'Province of British Columbia', 'BC_GENERAL',
    'BC Building, Plumbing and Fire Code bulletins', '2024', null,
    '2024-03-08', null,
    'https://www2.gov.bc.ca/gov/content/industry/construction-industry/building-codes-standards/bc-codes/bulletins',
    'bulletin_index', null, null, 'BC code bulletin index', 60, 'current',
    'restricted_metadata_only', array['metadata', 'official_link', 'citation'],
    '2026-08-11T00:00:00Z', null
  ),
  (
    'vancouver-plumbing-bylaw-2025-original', 'City of Vancouver', 'VANCOUVER',
    'Vancouver Building By-law 2025, Book II (Plumbing Systems)', '2025',
    'By-law 14343', '2025-09-15', '2025-12-31',
    'https://vancouver.ca/your-government/vancouver-building-bylaw.aspx',
    'municipal_bylaw', null, 'vancouver-plumbing-bylaw-2025-current',
    'Vancouver Building By-law 2025, Book II', 100, 'superseded',
    'restricted_metadata_only', array['metadata', 'official_link', 'citation'],
    '2026-08-11T00:00:00Z', null
  ),
  (
    'vancouver-plumbing-bylaw-2025-current', 'City of Vancouver', 'VANCOUVER',
    'Vancouver Building By-law 2025, Book II (Plumbing Systems)', '2025',
    'By-law 14488', '2026-01-01', null,
    'https://vancouver.ca/your-government/vancouver-building-bylaw.aspx',
    'municipal_bylaw', 'vancouver-plumbing-bylaw-2025-original', null,
    'Vancouver Building By-law 2025, Book II, amended', 100, 'current',
    'restricted_metadata_only', array['metadata', 'official_link', 'citation'],
    '2026-08-11T00:00:00Z', null
  )
on conflict (source_id) do update set
  authority = excluded.authority,
  jurisdiction = excluded.jurisdiction,
  document_title = excluded.document_title,
  edition = excluded.edition,
  revision_id = excluded.revision_id,
  effective_from = excluded.effective_from,
  effective_to = excluded.effective_to,
  source_url = excluded.source_url,
  source_type = excluded.source_type,
  supersedes = excluded.supersedes,
  superseded_by = excluded.superseded_by,
  citation_label = excluded.citation_label,
  retrieval_priority = excluded.retrieval_priority,
  updated_at = now();