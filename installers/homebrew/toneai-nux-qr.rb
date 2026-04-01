# Formula for homebrew-tools repo: steve-krisjanovs/homebrew-tools
# Place this at: Formula/toneai-nux-qr.rb
#
# To install:
#   brew tap steve-krisjanovs/tools
#   brew install toneai-nux-qr

class ToneaiNuxQr < Formula
  desc "AI-generated NUX MightyAmp QR tone presets for any song or album"
  homepage "https://github.com/steve-krisjanovs/toneai-nux-qr"
  version "1.0.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/steve-krisjanovs/toneai-nux-qr/releases/download/v#{version}/tnqr-mac-arm64"
      sha256 "REPLACE_WITH_ARM64_SHA256"
    end
    on_intel do
      url "https://github.com/steve-krisjanovs/toneai-nux-qr/releases/download/v#{version}/tnqr-mac-x64"
      sha256 "REPLACE_WITH_X64_SHA256"
    end
  end

  def install
    bin.install Dir["tnqr-mac-*"].first => "tnqr"
  end

  test do
    assert_match "tnqr", shell_output("#{bin}/tnqr --help")
  end
end
