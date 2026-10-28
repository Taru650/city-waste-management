package com.google.android.play.core.integrity;
public abstract class IntegrityTokenRequest {
  public static Builder builder() { return null; }
  public abstract static class Builder {
    public abstract Builder setNonce(String nonce);
    public abstract Builder setCloudProjectNumber(long n);
    public abstract IntegrityTokenRequest build();
  }
}
