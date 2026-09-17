import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ImageDropzone from './ImageDropzone';

function makeFile(name: string, type: string): File {
  return new File(['contents'], name, { type });
}

describe('ImageDropzone', () => {
  it('shows the combined click-or-drag instructions when empty', () => {
    render(<ImageDropzone file={null} previewUrl={null} onSelect={vi.fn()} onClear={vi.fn()} />);
    expect(
      screen.getByText(/click here to upload from your file system.*drag the picture here/i)
    ).toBeInTheDocument();
  });

  it('calls onSelect when a valid image is dropped', () => {
    const onSelect = vi.fn();
    render(<ImageDropzone file={null} previewUrl={null} onSelect={onSelect} onClear={vi.fn()} />);

    const zone = screen.getByTestId('image-dropzone');
    const file = makeFile('mini.png', 'image/png');
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });

    expect(onSelect).toHaveBeenCalledWith(file);
  });

  it('calls onSelect when a valid image is chosen via the file picker', async () => {
    const onSelect = vi.fn();
    render(<ImageDropzone file={null} previewUrl={null} onSelect={onSelect} onClear={vi.fn()} />);

    const input = screen.getByTestId('image-input') as HTMLInputElement;
    const file = makeFile('mini.png', 'image/png');
    await userEvent.upload(input, file);

    expect(onSelect).toHaveBeenCalledWith(file);
  });

  it('rejects a dropped non-image file and does not call onSelect', () => {
    const onSelect = vi.fn();
    render(<ImageDropzone file={null} previewUrl={null} onSelect={onSelect} onClear={vi.fn()} />);

    const zone = screen.getByTestId('image-dropzone');
    const file = makeFile('malware.exe', 'application/x-msdownload');
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText(/only image files are allowed/i)).toBeInTheDocument();
  });

  it('ignores a drop with no files in it', () => {
    const onSelect = vi.fn();
    render(<ImageDropzone file={null} previewUrl={null} onSelect={onSelect} onClear={vi.fn()} />);

    fireEvent.drop(screen.getByTestId('image-dropzone'), { dataTransfer: { files: [] } });

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByText(/only image files/i)).not.toBeInTheDocument();
  });

  it('clears the error once a valid image is picked after a bad one', () => {
    const onSelect = vi.fn();
    render(<ImageDropzone file={null} previewUrl={null} onSelect={onSelect} onClear={vi.fn()} />);
    const zone = screen.getByTestId('image-dropzone');

    fireEvent.drop(zone, { dataTransfer: { files: [makeFile('notes.txt', 'text/plain')] } });
    expect(screen.getByText(/only image files/i)).toBeInTheDocument();

    fireEvent.drop(zone, { dataTransfer: { files: [makeFile('mini.png', 'image/png')] } });
    expect(screen.queryByText(/only image files/i)).not.toBeInTheDocument();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('highlights the box while a file is dragged over it', () => {
    render(<ImageDropzone file={null} previewUrl={null} onSelect={vi.fn()} onClear={vi.fn()} />);
    const zone = screen.getByTestId('image-dropzone');

    fireEvent.dragOver(zone);
    expect(zone.style.border).toContain('rgb(201, 168, 76)');

    fireEvent.dragLeave(zone);
    expect(zone.style.border).not.toContain('rgb(201, 168, 76)');
  });

  it('only offers image types in the file browser', () => {
    render(<ImageDropzone file={null} previewUrl={null} onSelect={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByTestId('image-input')).toHaveAttribute('accept', 'image/*');
  });

  it('shows a preview image and a Remove button once a file is selected', () => {
    const onClear = vi.fn();
    render(
      <ImageDropzone
        file={makeFile('mini.png', 'image/png')}
        previewUrl="blob:fake-preview"
        onSelect={vi.fn()}
        onClear={onClear}
      />
    );

    expect(screen.getByAltText(/preview/i)).toHaveAttribute('src', 'blob:fake-preview');
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    expect(onClear).toHaveBeenCalled();
  });
});
