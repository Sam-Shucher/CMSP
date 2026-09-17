import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ImageDropzone from './ImageDropzone';

function makeFile(name: string, type = 'image/png'): File {
  return new File(['contents'], name, { type });
}

// The box only collects files; MultiImagePicker decides which ones are usable.
describe('ImageDropzone', () => {
  it('shows the combined click-or-drag instructions', () => {
    render(<ImageDropzone onFiles={vi.fn()} />);
    expect(
      screen.getByText(/click here to upload from your file system.*drag the pictures? here/i)
    ).toBeInTheDocument();
  });

  it('hands over every file dropped at once', () => {
    const onFiles = vi.fn();
    render(<ImageDropzone onFiles={onFiles} />);

    const a = makeFile('front.png');
    const b = makeFile('back.png');
    fireEvent.drop(screen.getByTestId('image-dropzone'), { dataTransfer: { files: [a, b] } });

    expect(onFiles).toHaveBeenCalledWith([a, b]);
  });

  it('lets you pick several photos at once in the file browser', async () => {
    const onFiles = vi.fn();
    render(<ImageDropzone onFiles={onFiles} />);

    const input = screen.getByTestId('image-input') as HTMLInputElement;
    expect(input).toHaveAttribute('multiple');
    const a = makeFile('front.png');
    const b = makeFile('back.png');
    await userEvent.upload(input, [a, b]);

    expect(onFiles).toHaveBeenCalledWith([a, b]);
  });

  it('lets the same photo be picked again after it was removed', async () => {
    const onFiles = vi.fn();
    render(<ImageDropzone onFiles={onFiles} />);
    const input = screen.getByTestId('image-input') as HTMLInputElement;
    const photo = makeFile('front.png');

    await userEvent.upload(input, photo);
    expect(input.value).toBe('');
    await userEvent.upload(input, photo);

    expect(onFiles).toHaveBeenCalledTimes(2);
  });

  it('ignores a drop with no files in it', () => {
    const onFiles = vi.fn();
    render(<ImageDropzone onFiles={onFiles} />);

    fireEvent.drop(screen.getByTestId('image-dropzone'), { dataTransfer: { files: [] } });

    expect(onFiles).not.toHaveBeenCalled();
  });

  it('highlights the box while a file is dragged over it', () => {
    render(<ImageDropzone onFiles={vi.fn()} />);
    const zone = screen.getByTestId('image-dropzone');

    fireEvent.dragOver(zone);
    expect(zone.style.border).toContain('rgb(201, 168, 76)');

    fireEvent.dragLeave(zone);
    expect(zone.style.border).not.toContain('rgb(201, 168, 76)');
  });

  it('only offers image types in the file browser', () => {
    render(<ImageDropzone onFiles={vi.fn()} />);
    expect(screen.getByTestId('image-input')).toHaveAttribute('accept', 'image/jpeg,image/png,image/gif,image/webp');
  });
});
