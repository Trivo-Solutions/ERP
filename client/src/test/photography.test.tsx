import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const h = vi.hoisted(() => ({ apiPut: vi.fn(), apiGet: vi.fn(), del: vi.fn() }));
vi.mock('../api/client', () => ({
  api: { delete: h.del },
  apiGet: h.apiGet,
  apiPut: h.apiPut,
}));

import { DashboardView } from '../pages/Photography/PhotographyDashboard';
import { SettingsFormView, toForm, diffSettings } from '../pages/Photography/PhotographySettingsPage';
import {
  ImageCard, ImageGallery, ImageMeta, TagHeader, isDeleteReasonProvided,
} from '../pages/Photography/PhotographyCapturePage';
import {
  deleteImage, getImageUrl, saveSettings, lookupTag, listImages, errorMessage, photoKeys,
  type PhotographyDashboardData, type PhotographySettingsResponse, type TagImage, type PhotographyTag,
} from '../pages/Photography/photographyApi';
import { PermissionGate } from '../components/auth/PermissionGate';
import { RequirePermission } from '../components/auth/RequirePermission';
import { useAuthStore } from '../store/auth.store';

const dash = (o: Partial<PhotographyDashboardData> = {}): PhotographyDashboardData => ({
  todaysPhotos: 37, pendingProcessing: 4, processingFailed: 0, imagesReviewed: 9, imagesDeletedToday: 2, activeStations: 3,
  storageUsage: { available: false, reason: 'Not measured yet' }, ...o,
});

// Deliberately odd numbers: if the UI hard-coded a default (e.g. 500 KB) these assertions would catch it.
const settingsResponse = (): PhotographySettingsResponse => ({
  settings: {
    generateOptimized: true, targetOptimizedSizeKB: 777, minimumQuality: 41, maximumQuality: 93, maximumWidth: 1999, maximumHeight: 1888,
    minimumLongEdge: 666, optimizedFormat: 'JPEG', generateThumbnail: true, thumbnailWidth: 211, thumbnailHeight: 212, thumbnailCrop: true,
    thumbnailFormat: 'WEBP', thumbnailQuality: 66, keepOriginal: true, autoOrient: false, maxInputWidth: 9001, maxInputHeight: 9002,
  },
  defaults: {} as any,
  limits: { targetOptimizedSizeKB: [50, 10240] },
  formats: ['WEBP', 'JPEG'],
  usingDefaults: false,
});

const image = (o: Partial<TagImage> = {}): TagImage => ({
  id: 'img1', tagId: 't1', imageType: 'SIDE', isPrimary: false, reviewStatus: null, uploadStatus: 'CONFIRMED', processingStatus: 'READY',
  originalFilename: 'a.jpg', mimeType: 'image/jpeg', width: 100, height: 100, sizeBytes: 10, captureSource: 'DEVICE_CAMERA', cameraLabel: null,
  capturedAt: '2026-10-08T05:00:00Z', createdAt: '2026-10-08T05:00:00Z', station: { id: 's1', name: 'Bench 1' },
  variants: { original: true, optimized: true, thumbnail: true }, ...o,
});

const withQuery = (el: React.ReactElement, seed?: (qc: QueryClient) => void) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  seed?.(qc);
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{el}</QueryClientProvider>);
};

beforeEach(() => { h.apiPut.mockReset(); h.apiGet.mockReset(); h.del.mockReset(); });

describe('Photography dashboard', () => {
  it('renders the API statistics as returned', () => {
    const html = renderToStaticMarkup(<DashboardView data={dash()} />);
    expect(html).toContain('37');
    expect(html).toContain('Pending processing');
    expect(html).toContain('Reviewed images');
    expect(html).toContain('Deleted today');
    expect(html).not.toContain('failed processing'); // no warning at 0
  });

  it('warns visibly when processing failed > 0, with no retry button', () => {
    const html = renderToStaticMarkup(<DashboardView data={dash({ processingFailed: 5 })} />);
    expect(html).toContain('5 images failed processing');
    expect(html.toLowerCase()).not.toContain('retry');
    expect(html.toLowerCase()).not.toContain('reprocess');
  });

  it('shows a loading state without fabricating numbers', () => {
    const html = renderToStaticMarkup(<DashboardView loading />);
    expect(html).toContain('MuiSkeleton');
    expect(html).not.toContain('>0<');
  });

  it('shows the server error', () => {
    const html = renderToStaticMarkup(<DashboardView error={{ response: { data: { error: 'Boom from server' } } }} />);
    expect(html).toContain('Boom from server');
  });

  it('shows storage usage as Not available, never a fake 0 GB', () => {
    const html = renderToStaticMarkup(<DashboardView data={dash()} />);
    expect(html).toContain('Not available');
    expect(html).toContain('Not measured yet');
    expect(html).not.toMatch(/0\s*GB/);
  });
});

describe('Photography settings', () => {
  const render = (over: Partial<React.ComponentProps<typeof SettingsFormView>> = {}) => {
    const data = settingsResponse();
    return renderToStaticMarkup(
      <SettingsFormView data={data} form={toForm(data.settings)} setField={() => {}} dirty={false} saving={false} onSave={() => {}} onReset={() => {}} {...over} />,
    );
  };

  it('shows the API values and hard-codes none', () => {
    const html = render();
    for (const v of ['777', '41', '93', '1999', '1888', '666', '211', '212', '66', '9001', '9002']) expect(html).toContain(`value="${v}"`);
    expect(html).not.toContain('value="500"');
  });

  it('renders every supported setting', () => {
    const html = render();
    for (const l of [
      'Generate optimized image', 'Target optimized size', 'Minimum quality', 'Maximum quality', 'Maximum width', 'Maximum height',
      'Minimum long edge', 'Optimized format', 'Generate thumbnail', 'Thumbnail width', 'Thumbnail height', 'Crop to fill',
      'Thumbnail format', 'Thumbnail quality', 'Keep original', 'Auto orientation', 'Maximum input width', 'Maximum input height',
    ]) expect(html).toContain(l);
    expect(html).toContain('keep the optimized image at or below the configured target size');
  });

  it('shows Keep original as enabled but read-only', () => {
    const html = render();
    const m = html.match(/<input[^>]*aria-label="Keep original"[^>]*>/)![0];
    expect(m).toContain('checked');
    expect(m).toContain('disabled');
  });

  it('disables Save when clean and enables it when dirty', () => {
    expect(render()).toMatch(/<button[^>]*disabled[^>]*>Save settings/);
    expect(render({ dirty: true })).not.toMatch(/<button[^>]*disabled[^>]*>Save settings/);
  });

  it('surfaces a backend validation message', () => {
    expect(render({ error: 'minimumQuality cannot be greater than maximumQuality' })).toContain('minimumQuality cannot be greater than maximumQuality');
  });

  it('says so when the company is on server defaults', () => {
    expect(render({ data: { ...settingsResponse(), usingDefaults: true } })).toContain('server&#x27;s defaults');
  });

  it('diffs only changed fields (numbers compared as numbers)', () => {
    const s = settingsResponse().settings;
    const form = toForm(s);
    expect(diffSettings(s, form)).toEqual({});
    expect(diffSettings(s, { ...form, targetOptimizedSizeKB: '800', autoOrient: true })).toEqual({ targetOptimizedSizeKB: 800, autoOrient: true });
  });

  it('saves through PUT with just the patch', async () => {
    h.apiPut.mockResolvedValue(settingsResponse());
    await saveSettings({ targetOptimizedSizeKB: 800 });
    expect(h.apiPut).toHaveBeenCalledWith('/photography/settings', { targetOptimizedSizeKB: 800 });
  });

  it('extracts the API error text', () => {
    expect(errorMessage({ response: { data: { error: 'Unknown setting: companyId' } } })).toBe('Unknown setting: companyId');
  });
});

describe('Photography permissions', () => {
  const login = (permissions: string[]) =>
    useAuthStore.setState({ user: { permissions } as any, isAuthenticated: true } as any);

  it('hides Settings without photography:manage_settings (route guard and gate)', () => {
    login(['photography:view', 'photography:capture']);
    const route = renderToStaticMarkup(<RequirePermission permission="photography:manage_settings"><p>SETTINGS</p></RequirePermission>);
    expect(route).toContain('Access Restricted');
    expect(route).not.toContain('SETTINGS');
  });

  it('allows Settings with the permission', () => {
    login(['photography:manage_settings']);
    expect(renderToStaticMarkup(<RequirePermission permission="photography:manage_settings"><p>SETTINGS</p></RequirePermission>)).toContain('SETTINGS');
  });

  it('shows Delete only with photography:delete', () => {
    login(['photography:view']);
    expect(renderToStaticMarkup(<PermissionGate permission="photography:delete"><button>Delete</button></PermissionGate>)).toBe('');
    login(['photography:delete']);
    expect(renderToStaticMarkup(<PermissionGate permission="photography:delete"><button>Delete</button></PermissionGate>)).toContain('Delete');
  });
});

describe('Photography capture', () => {
  const tag: PhotographyTag = {
    id: 't1', tagNumber: 'TAG-0042', name: 'Ring', status: 'IN_STOCK', metalType: 'GOLD', metalKarat: '22K', grossWeight: '5', netWeight: '4.5',
    branch: { id: 'b1', name: 'Main Branch' }, category: { id: 'c1', name: 'Rings' },
    photography: { imageCount: 2, hasPrimary: true, primaryImageId: 'img1', lastCapturedAt: '2026-10-08T05:00:00Z' },
  };

  it('looks a tag up by number via the photography API', async () => {
    h.apiGet.mockResolvedValue(tag);
    await lookupTag('TAG/42 7');
    expect(h.apiGet).toHaveBeenCalledWith('/photography/tags/TAG%2F42%207');
  });

  it('renders the tag header with branch, status and photo readiness', () => {
    const html = renderToStaticMarkup(<TagHeader tag={tag} />);
    for (const t of ['TAG-0042', 'Main Branch', 'IN_STOCK', '2 photos', 'Has primary']) expect(html).toContain(t);
  });

  it('lists images from the tag-images endpoint', async () => {
    h.apiGet.mockResolvedValue([]);
    await listImages('t1');
    expect(h.apiGet).toHaveBeenCalledWith('/photography/tags/t1/images');
  });

  it('requests the signed URL with the chosen variant', async () => {
    h.apiGet.mockResolvedValue({ url: 'x' });
    await getImageUrl('img1', 'thumbnail');
    expect(h.apiGet).toHaveBeenCalledWith('/photography/images/img1/url', { variant: 'thumbnail' });
  });

  it('gallery uses the cached thumbnail signed URL and marks the primary image', () => {
    const img = image({ isPrimary: true });
    const html = withQuery(<ImageGallery images={[img, image({ id: 'img2' })]} typeFilter={null} onOpen={() => {}} />, (qc) => {
      qc.setQueryData(photoKeys.url('img1', 'thumbnail'), { imageId: 'img1', variant: 'thumbnail', url: 'https://signed.example/thumb1', expiresInSeconds: 300, mimeType: 'image/jpeg' });
    });
    expect(html).toContain('src="https://signed.example/thumb1"');
    expect(html).toContain('PRIMARY');
    expect(html).not.toContain('storageKey');
  });

  it('falls back to the original only when no smaller variant exists', () => {
    const img = image({ variants: { original: true, optimized: false, thumbnail: false } });
    const html = withQuery(<ImageCard img={img} onOpen={() => {}} />, (qc) => {
      qc.setQueryData(photoKeys.url('img1', 'original'), { imageId: 'img1', variant: 'original', url: 'https://signed.example/orig', expiresInSeconds: 300, mimeType: null });
    });
    expect(html).toContain('https://signed.example/orig');
  });

  it('shows empty and filtered-empty states', () => {
    expect(renderToStaticMarkup(<ImageGallery images={[]} typeFilter={null} onOpen={() => {}} />)).toContain('No photos yet');
    expect(withQuery(<ImageGallery images={[image()]} typeFilter="BACK" onOpen={() => {}} />)).toContain('No BACK photos');
  });

  it('preview metadata shows type, time, station, processing, review — and no storage details', () => {
    const html = renderToStaticMarkup(<ImageMeta img={image({ reviewStatus: 'APPROVED' })} />);
    for (const t of ['SIDE', 'Bench 1', 'READY', 'APPROVED']) expect(html).toContain(t);
    expect(html.toLowerCase()).not.toContain('bucket');
    expect(html).not.toContain('storageKey');
  });

  it('requires a non-blank delete reason', () => {
    expect(isDeleteReasonProvided('')).toBe(false);
    expect(isDeleteReasonProvided('   ')).toBe(false);
    expect(isDeleteReasonProvided('wrong tag')).toBe(true);
  });

  it('deletes through DELETE with the reason in the body', async () => {
    h.del.mockResolvedValue({ data: { data: { id: 'img1', deleted: true } } });
    await expect(deleteImage('img1', 'wrong tag')).resolves.toEqual({ id: 'img1', deleted: true });
    expect(h.del).toHaveBeenCalledWith('/photography/images/img1', { data: { reason: 'wrong tag' } });
  });
});
