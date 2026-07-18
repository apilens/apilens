package ai.apilens.internal;

import ai.apilens.ApiLensConfig;
import java.io.InputStream;
import java.net.http.HttpClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.time.Duration;
import java.util.Collection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

public final class HttpClients {
  private HttpClients() {}

  public static HttpClient create(ApiLensConfig config) {
    HttpClient.Builder builder = HttpClient.newBuilder()
        .connectTimeout(config.timeout())
        .version(HttpClient.Version.HTTP_1_1);

    if (!config.verifyTls()) {
      builder.sslContext(trustAllContext());
      SSLParameters sslParameters = new SSLParameters();
      sslParameters.setEndpointIdentificationAlgorithm("");
      builder.sslParameters(sslParameters);
    } else if (!Strings.isBlank(config.caBundlePath())) {
      builder.sslContext(caBundleContext(config.caBundlePath()));
    }

    return builder.build();
  }

  private static SSLContext caBundleContext(String caBundlePath) {
    try (InputStream in = Files.newInputStream(Path.of(caBundlePath))) {
      CertificateFactory certificateFactory = CertificateFactory.getInstance("X.509");
      Collection<? extends Certificate> certificates = certificateFactory.generateCertificates(in);
      KeyStore keyStore = KeyStore.getInstance(KeyStore.getDefaultType());
      keyStore.load(null, null);
      int index = 0;
      for (Certificate certificate : certificates) {
        keyStore.setCertificateEntry("apilens-ca-" + index, certificate);
        index += 1;
      }
      TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
      tmf.init(keyStore);
      SSLContext context = SSLContext.getInstance("TLS");
      context.init(null, tmf.getTrustManagers(), new SecureRandom());
      return context;
    } catch (Exception ex) {
      throw new IllegalArgumentException("Could not load API Lens CA bundle from " + caBundlePath, ex);
    }
  }

  private static SSLContext trustAllContext() {
    try {
      TrustManager[] trustManagers = new TrustManager[] {
          new X509TrustManager() {
            @Override
            public void checkClientTrusted(java.security.cert.X509Certificate[] chain, String authType) {}

            @Override
            public void checkServerTrusted(java.security.cert.X509Certificate[] chain, String authType) {}

            @Override
            public java.security.cert.X509Certificate[] getAcceptedIssuers() {
              return new java.security.cert.X509Certificate[0];
            }
          }
      };
      SSLContext context = SSLContext.getInstance("TLS");
      context.init(null, trustManagers, new SecureRandom());
      return context;
    } catch (Exception ex) {
      throw new IllegalStateException("Could not create unverified TLS context", ex);
    }
  }
}
