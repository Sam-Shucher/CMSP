import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MultiImagePicker from './MultiImagePicker';

function makeFile(name: string, type = 'image/png', size?: number): File {
  const file = new File(['contents'], name, { type });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return file;
}

function drop(...files: File[]) {
  fireEvent.drop(screen.getByTestId('image-dropzone'), { dataTransfer: { files } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MultiImagePicker', () => {
  it('shows a thumbnail for each existing image and lets you remove one', () => {
    const onChange = vi.fn();
    render(
      <MultiImagePicker
        existingPaths={['/uploads/a.png', '/uploads/b.png']}
        onChange={onChange}
      />
    );

    expect(screen.getAllByRole('img')).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[0]);
    expect(onChange).toHaveBeenCalledWith(['/uploads/b.png'], []);
  });

  it('shows an add dropzone while under the 3-image cap, and adds a dropped file', async () => {
    const onChange = vi.fn();
    render(<MultiImagePicker existingPaths={['/uploads/a.png']} onChange={onChange} />);

    const file = makeFile('new.png');
    drop(file);

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(['/uploads/a.png'], [file]));
  });

  it('adds several photos at once, up to the 3-photo limit, and says which didn\'t fit', async () => {
    const onChange = vi.fn();
    render(<MultiImagePicker existingPaths={['/uploads/a.png']} onChange={onChange} />);

    const [front, back, side] = [makeFile('front.jpg', 'image/jpeg'), makeFile('back.jpg', 'image/jpeg'), makeFile('side.jpg', 'image/jpeg')];
    drop(front, back, side);

    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(['/uploads/a.png'], [front, back]));
    expect(screen.getAllByAltText('Preview')).toHaveLength(2);
    expect(screen.getByText('Only 3 photos fit — "side.jpg" wasn\'t added.')).toBeInTheDocument();
  });

  it('explains that iPhone HEIC photos need converting', async () => {
    const onChange = vi.fn();
    render(<MultiImagePicker existingPaths={[]} onChange={onChange} />);

    drop(makeFile('IMG_4412.HEIC', 'image/heic'));

    expect(await screen.findByText(/"IMG_4412.HEIC" is an iPhone HEIC photo, which browsers can't show/)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('refuses a photo over 10 MB, saying how big it is — before uploading anything', async () => {
    const onChange = vi.fn();
    render(<MultiImagePicker existingPaths={[]} onChange={onChange} />);

    drop(makeFile('PXL_huge.jpg', 'image/jpeg', 20.4 * 1024 * 1024));

    expect(await screen.findByText('"PXL_huge.jpg" is 20.4 MB — photos must be 10 MB or smaller.')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([
    ['a PDF', 'receipt.pdf', 'application/pdf'],
    ['an SVG drawing', 'logo.svg', 'image/svg+xml'],
    ['a BMP', 'scan.bmp', 'image/bmp'],
  ])('refuses %s', async (_what, name, type) => {
    const onChange = vi.fn();
    render(<MultiImagePicker existingPaths={[]} onChange={onChange} />);

    drop(makeFile(name, type));

    expect(await screen.findByText(`"${name}" isn't a JPG, PNG, GIF, or WebP photo.`)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('refuses a file that is named like a photo but can\'t be opened as one', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('The source image could not be decoded.'); }));
    const onChange = vi.fn();
    render(<MultiImagePicker existingPaths={[]} onChange={onChange} />);

    drop(makeFile('notes.png'));

    expect(await screen.findByText('"notes.png" doesn\'t look like a photo we can open.')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByAltText('Preview')).not.toBeInTheDocument();
  });

  it('adds the good photos from a mixed batch, and clears old problems on the next good pick', async () => {
    const onChange = vi.fn();
    render(<MultiImagePicker existingPaths={[]} onChange={onChange} />);
    const good = makeFile('good.png');

    drop(makeFile('receipt.pdf', 'application/pdf'), good);

    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([], [good]));
    expect(screen.getByText(/"receipt.pdf" isn't a JPG/)).toBeInTheDocument();

    drop(makeFile('another.png'));
    await waitFor(() => expect(screen.queryByText(/"receipt.pdf"/)).not.toBeInTheDocument());
  });

  it('lets you remove a newly added photo before saving, keeping the others', async () => {
    const onChange = vi.fn();
    render(<MultiImagePicker existingPaths={['/uploads/a.png']} onChange={onChange} />);

    const first = makeFile('first.png');
    const second = makeFile('second.png');
    drop(first);
    await screen.findByAltText('Preview');
    drop(second);
    await waitFor(() => expect(screen.getAllByAltText('Preview')).toHaveLength(2));

    fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[1]); // first new photo

    expect(onChange).toHaveBeenLastCalledWith(['/uploads/a.png'], [second]);
    expect(screen.getAllByAltText('Preview')).toHaveLength(1);
  });

  it('brings the dropzone back after removing a photo at the cap', () => {
    render(
      <MultiImagePicker
        existingPaths={['/uploads/a.png', '/uploads/b.png', '/uploads/c.png']}
        onChange={vi.fn()}
      />
    );

    fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[0]);

    expect(screen.getByTestId('image-dropzone')).toBeInTheDocument();
  });

  it('hides the add dropzone once 3 images are already selected', () => {
    render(
      <MultiImagePicker
        existingPaths={['/uploads/a.png', '/uploads/b.png', '/uploads/c.png']}
        onChange={vi.fn()}
      />
    );

    expect(screen.queryByTestId('image-dropzone')).not.toBeInTheDocument();
    expect(screen.getByText(/3 of 3/i)).toBeInTheDocument();
  });

  it('starts empty when no existingPaths are given (create mode)', () => {
    render(<MultiImagePicker existingPaths={[]} onChange={vi.fn()} />);
    expect(screen.queryAllByRole('img')).toHaveLength(0);
    expect(screen.getByTestId('image-dropzone')).toBeInTheDocument();
  });
});
