////////////////////////////////////////////////////////////////////////////////
/// DISCLAIMER
///
/// Copyright 2014-2016 ArangoDB GmbH, Cologne, Germany
/// Copyright 2004-2014 triAGENS GmbH, Cologne, Germany
///
/// Licensed under the Apache License, Version 2.0 (the "License");
/// you may not use this file except in compliance with the License.
/// You may obtain a copy of the License at
///
///     http://www.apache.org/licenses/LICENSE-2.0
///
/// Unless required by applicable law or agreed to in writing, software
/// distributed under the License is distributed on an "AS IS" BASIS,
/// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
/// See the License for the specific language governing permissions and
/// limitations under the License.
///
/// Copyright holder is ArangoDB GmbH, Cologne, Germany
///
/// @author Jan Steemann
////////////////////////////////////////////////////////////////////////////////

#include "Endpoint.h"

#include "Basics/StringUtils.h"
#include "Basics/socket-utils.h"
#include "Endpoint/EndpointIpV4.h"
#include "Endpoint/EndpointIpV6.h"
#include "Endpoint/EndpointSrv.h"
#include "Logger/Logger.h"

#if ARANGODB_HAVE_DOMAIN_SOCKETS
#include "Endpoint/EndpointUnixDomain.h"
#endif

using namespace arangodb;
using namespace arangodb::basics;

Endpoint::Endpoint(DomainType domainType, EndpointType type,
                   TransportType transport, EncryptionType encryption,
                   std::string const& specification, int listenBacklog)
    : _domainType(domainType),
      _type(type),
      _transport(transport),
      _encryption(encryption),
      _specification(specification),
      _listenBacklog(listenBacklog),
      _connected(false) {
  TRI_invalidatesocket(&_socket);
}

////////////////////////////////////////////////////////////////////////////////
/// @brief return the endpoint specification in a unified form
////////////////////////////////////////////////////////////////////////////////

std::string Endpoint::unifiedForm(std::string const& specification) {
  static std::string illegal;

  if (specification.size() < 7) {
    return illegal;
  }

  TransportType protocol = TransportType::HTTP;

  std::string prefix = "http+";
  std::string copy = StringUtils::tolower(specification);
  StringUtils::trimInPlace(copy);

  if (specification[specification.size() - 1] == '/') {
    // address ends with a slash => remove
    copy = copy.substr(0, copy.size() - 1);
  }

  // read protocol from string
  if (StringUtils::isPrefix(copy, "http+")) {
    protocol = TransportType::HTTP;
    prefix = "http+";
    copy = copy.substr(5);
  }

  if (StringUtils::isPrefix(copy, "vpp+")) {
    protocol = TransportType::VPP;
    prefix = "vsp+";
    copy = copy.substr(4);
  }

  if (StringUtils::isPrefix(copy, "unix://")) {
#if ARANGODB_HAVE_DOMAIN_SOCKETS
    return prefix + copy;
#else
    // no unix socket for windows
    return illegal;
#endif
  }

  if (StringUtils::isPrefix(copy, "srv://")) {
#ifndef _WIN32
    return prefix + copy;
#else
    return illegal;
#endif
  }

  if (!StringUtils::isPrefix(copy, "ssl://") &&
      !StringUtils::isPrefix(copy, "tcp://")) {
    return illegal;
  }

  // handle tcp or ssl
  size_t found;
  std::string temp = copy.substr(6, copy.length());  // strip tcp:// or ssl://

  if (temp[0] == '[') {
    // ipv6
    found = temp.find("]:", 1);
    if (found != std::string::npos && found > 2 && found + 2 < temp.size()) {
      // hostname and port (e.g. [address]:port)
      return prefix + copy;
    }

    found = temp.find("]", 1);
    if (found != std::string::npos && found > 2 && found + 1 == temp.size()) {
      // hostname only (e.g. [address])
      if (protocol == TransportType::VPP) {
        return prefix + copy + ":" +
               StringUtils::itoa(EndpointIp::_defaultPortVpp);
      } else {
        return prefix + copy + ":" +
               StringUtils::itoa(EndpointIp::_defaultPortHttp);
      }
    }

    // invalid address specification
    return illegal;
  }

  // ipv4
  found = temp.find(':');

  if (found != std::string::npos && found + 1 < temp.size()) {
    // hostname and port
    return prefix + copy;
  }

  // hostname only

  if (protocol == TransportType::HTTP) {
    return prefix + copy + ":" + StringUtils::itoa(EndpointIp::_defaultPortHttp);
  } else {
    return prefix + copy + ":" +
           StringUtils::itoa(EndpointIp::_defaultPortVpp);
  }
}

////////////////////////////////////////////////////////////////////////////////
/// @brief create a server endpoint object from a string value
////////////////////////////////////////////////////////////////////////////////

Endpoint* Endpoint::serverFactory(std::string const& specification,
                                  int listenBacklog, bool reuseAddress) {
  return Endpoint::factory(EndpointType::SERVER, specification, listenBacklog,
                           reuseAddress);
}

////////////////////////////////////////////////////////////////////////////////
/// @brief create a client endpoint object from a string value
////////////////////////////////////////////////////////////////////////////////

Endpoint* Endpoint::clientFactory(std::string const& specification) {
  return Endpoint::factory(EndpointType::CLIENT, specification, 0, false);
}

////////////////////////////////////////////////////////////////////////////////
/// @brief create an endpoint object from a string value
////////////////////////////////////////////////////////////////////////////////

Endpoint* Endpoint::factory(const Endpoint::EndpointType type,
                            std::string const& specification, int listenBacklog,
                            bool reuseAddress) {
  if (specification.size() < 7) {
    return nullptr;
  }

  if (listenBacklog > 0 && type == EndpointType::CLIENT) {
    // backlog is only allowed for server endpoints
    TRI_ASSERT(false);
  }

  if (listenBacklog == 0 && type == EndpointType::SERVER) {
    // use some default value
    listenBacklog = 10;
  }

  std::string copy = unifiedForm(specification);
  std::string prefix = "http";
  TransportType protocol = TransportType::HTTP;

  if (StringUtils::isPrefix(copy, "http+")) {
    protocol = TransportType::HTTP;
    prefix = "http+";
    copy = copy.substr(5);
  } else if (StringUtils::isPrefix(copy, "vpp+")) {
    protocol = TransportType::VPP;
    prefix = "vpp+";
    copy = copy.substr(4);
  } else {
    // invalid protocol
    return nullptr;
  }

  EncryptionType encryption = EncryptionType::NONE;

  if (StringUtils::isPrefix(copy, "unix://")) {
#if ARANGODB_HAVE_DOMAIN_SOCKETS
    if (protocol != TransportType::HTTP) {
      return nullptr;
    }

    return new EndpointUnixDomain(type, listenBacklog, copy.substr(7));
#else
    // no unix socket for windows
    return nullptr;
#endif
  }

  if (StringUtils::isPrefix(copy, "srv://")) {
    if (type != EndpointType::CLIENT) {
      return nullptr;
    }

    if (protocol != TransportType::HTTP) {
      return nullptr;
    }

#ifndef _WIN32
    return new EndpointSrv(copy.substr(6));
#else
    return nullptr;
#endif
  }

  if (StringUtils::isPrefix(copy, "ssl://")) {
    encryption = EncryptionType::SSL;
  } else if (!StringUtils::isPrefix(copy, "tcp://")) {
    // invalid type
    return nullptr;
  }

  // tcp or ssl
  copy = copy.substr(6);
  uint16_t defaultPort = (protocol == TransportType::HTTP)
                             ? EndpointIp::_defaultPortHttp
                             : EndpointIp::_defaultPortVpp;

  size_t found;

  if (copy[0] == '[') {
    found = copy.find("]:", 1);

    // hostname and port (e.g. [address]:port)
    if (found != std::string::npos && found > 2 && found + 2 < copy.size()) {
      uint16_t port = (uint16_t)StringUtils::uint32(copy.substr(found + 2));
      std::string host = copy.substr(1, found - 1);

      return new EndpointIpV6(type, protocol, encryption, listenBacklog,
                              reuseAddress, host, port);
    }

    found = copy.find("]", 1);

    // hostname only (e.g. [address])
    if (found != std::string::npos && found > 2 && found + 1 == copy.size()) {
      std::string host = copy.substr(1, found - 1);

      return new EndpointIpV6(type, protocol, encryption, listenBacklog,
                              reuseAddress, host, defaultPort);
    }

    // invalid address specification
    return nullptr;
  }

  // ipv4
  found = copy.find(':');

  // hostname and port
  if (found != std::string::npos && found + 1 < copy.size()) {
    uint16_t port = (uint16_t)StringUtils::uint32(copy.substr(found + 1));
    std::string host = copy.substr(0, found);

    return new EndpointIpV4(type, protocol, encryption, listenBacklog,
                            reuseAddress, host, port);
  }

  // hostname only
  return new EndpointIpV4(type, protocol, encryption, listenBacklog,
                          reuseAddress, copy, defaultPort);
}

////////////////////////////////////////////////////////////////////////////////
/// @brief return the default endpoint (http/vstream)
////////////////////////////////////////////////////////////////////////////////

std::string const Endpoint::defaultEndpoint(TransportType type) {
  switch (type) {
    case TransportType::HTTP:
      return "http+tcp://" + std::string(EndpointIp::_defaultHost) + ":" +
             StringUtils::itoa(EndpointIp::_defaultPortHttp);

    case TransportType::VPP:
      return "vpp+tcp://" + std::string(EndpointIp::_defaultHost) + ":" +
             StringUtils::itoa(EndpointIp::_defaultPortVpp);
  }
}

////////////////////////////////////////////////////////////////////////////////
/// @brief compare two endpoints
////////////////////////////////////////////////////////////////////////////////

bool Endpoint::operator==(Endpoint const& that) const {
  return specification() == that.specification();
}

////////////////////////////////////////////////////////////////////////////////
/// @brief set socket timeout
////////////////////////////////////////////////////////////////////////////////

bool Endpoint::setTimeout(TRI_socket_t s, double timeout) {
  return TRI_setsockopttimeout(s, timeout);
}

////////////////////////////////////////////////////////////////////////////////
/// @brief set common socket flags
////////////////////////////////////////////////////////////////////////////////

bool Endpoint::setSocketFlags(TRI_socket_t s) {
  if (_encryption == EncryptionType::SSL && _type == EndpointType::CLIENT) {
    // SSL client endpoints are not set to non-blocking
    return true;
  }

  // set to non-blocking, executed for both client and server endpoints
  bool ok = TRI_SetNonBlockingSocket(s);

  if (!ok) {
    LOG(ERR) << "cannot switch to non-blocking: " << errno << " ("
             << strerror(errno) << ")";

    return false;
  }

  // set close-on-exec flag, executed for both client and server endpoints
  ok = TRI_SetCloseOnExecSocket(s);

  if (!ok) {
    LOG(ERR) << "cannot set close-on-exit: " << errno << " (" << strerror(errno)
             << ")";

    return false;
  }

  return true;
}